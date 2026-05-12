import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from 'baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import { generateReply } from './ai.js';

const logger = pino({ level: 'warn' });

function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  );
}

export class WhatsAppSession {
  constructor(store) {
    this.store = store;
    this.sock = null;
    this._reconnectTimer = null;
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.store.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: [`MyStore Agent · ${this.store.tenantId}`, 'Chrome', '1.0'],
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        const dataUrl = await qrcode.toDataURL(qr);
        this.store.setConnection('qr', dataUrl);
      }
      if (connection === 'open') {
        this.store.setConnection('connected');
        console.log(`[wa:${this.store.tenantId}] conectado`);
      }
      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error).output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.store.setConnection(loggedOut ? 'logged_out' : 'disconnected');
        console.log(`[wa:${this.store.tenantId}] cerrado code=${code} reconnect=${!loggedOut}`);
        if (!loggedOut) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = setTimeout(() => this.start().catch(console.error), 3000);
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        await this._handleIncoming(m).catch((e) =>
          console.error(`[wa:${this.store.tenantId}] handle`, e.message)
        );
      }
    });

    return this.sock;
  }

  async _handleIncoming(msg) {
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

    const text = extractText(msg.message);
    if (!text.trim()) return;

    const name = msg.pushName || undefined;
    const conv = this.store.addMessage(jid, { role: 'user', text }, name);

    if (conv.mode !== 'ai') return;

    try {
      await this.sock.sendPresenceUpdate('composing', jid);
      const reply = await generateReply({
        systemPrompt: this.store.config.systemPrompt,
        history: conv.messages,
      });
      if (reply && reply.trim()) {
        await this.sock.sendMessage(jid, { text: reply });
        this.store.addMessage(jid, { role: 'assistant', text: reply });
      }
      await this.sock.sendPresenceUpdate('paused', jid);
    } catch (e) {
      console.error(`[ai:${this.store.tenantId}]`, e.message);
      this.store.addMessage(jid, { role: 'system', text: `Error IA: ${e.message}` });
    }
  }

  async send(jid, text) {
    if (!this.sock) throw new Error('WhatsApp no conectado');
    await this.sock.sendMessage(jid, { text });
    this.store.addMessage(jid, { role: 'assistant', text, manual: true });
  }
}
