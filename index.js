import "dotenv/config";
import makeWASocket, {
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import pino from "pino";
import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
import readlineSync from "readline-sync";
import { Boom } from "@hapi/boom";

import {
  BOT_NAME,
  SESSION_PREFIX,
  AUTH_DIR,
  COMMAND_PREFIX,
  SESSION_ID,
  SESSION_PASSWORD
} from "./config.js";
import { exportSessionString, importSessionString } from "./session.js";

const logger = pino({ level: "silent" });

async function loadCommands() {
  const commands = new Map();
  const cmdDir = path.resolve("./commands");
  const files = await fs.readdir(cmdDir);

  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    const mod = await import(`./commands/${file}`);
    const cmd = mod.default;
    if (cmd?.name && typeof cmd.execute === "function") {
      commands.set(cmd.name.toLowerCase(), cmd);
    }
  }

  return commands;
}

function cleanNumber(input) {
  return String(input || "").replace(/\D/g, "");
}

function isPairMode() {
  return process.argv.includes("--pair");
}

function isGenSessionMode() {
  return process.argv.includes("--gensession");
}

async function importEnvSessionIfNeeded() {
  if (!SESSION_ID || !SESSION_PASSWORD) return;

  if (!SESSION_ID.startsWith(SESSION_PREFIX + ":")) {
    throw new Error(`SESSION_ID ${SESSION_PREFIX}: ilə başlamalıdır.`);
  }

  const credsPath = path.join(AUTH_DIR, "creds.json");
  const alreadyExists = await fs.pathExists(credsPath);
  if (alreadyExists) return;

  await fs.ensureDir(AUTH_DIR);
  await importSessionString(SESSION_ID, SESSION_PASSWORD, AUTH_DIR, SESSION_PREFIX);
  console.log(chalk.green("ENV session auth qovluğuna yazıldı."));
}

async function startBot() {
  await fs.ensureDir(AUTH_DIR);
  await importEnvSessionIfNeeded();

  const commands = await loadCommands();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {
    version = undefined;
  }

  const sock = makeWASocket({
    logger,
    auth: state,
    version,
    browser: [BOT_NAME, "Chrome", "1.0.0"],
    printQRInTerminal: false,
    syncFullHistory: false
  });

  let pairingRequested = false;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if ((connection === "connecting" || qr) && isPairMode() && !state.creds.registered && !pairingRequested) {
      pairingRequested = true;

      const rawNumber = readlineSync.question("WhatsApp nömrəsi (məs: 994501234567): ");
      const phoneNumber = cleanNumber(rawNumber);

      if (!phoneNumber) {
        console.log(chalk.red("Nömrə boş ola bilməz."));
        process.exit(1);
      }

      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(chalk.cyan(`Pairing code: ${code}`));
        console.log(chalk.yellow("WhatsApp > Linked Devices > Link with phone number ilə daxil et."));
      } catch (e) {
        console.error(chalk.red("Pairing code alınmadı:"), e?.message || e);
      }
    }

    if (connection === "open") {
      console.log(chalk.green(`${BOT_NAME} bağlandı və hazırdır.`));

      if (isGenSessionMode()) {
        try {
          const password = readlineSync.question("8 simvollu sifrə daxil et: ", {
            hideEchoBack: true
          });

          const sessionString = await exportSessionString(AUTH_DIR, password, SESSION_PREFIX);

          console.log(chalk.magenta("\n.env üçün bunları yaz:\n"));
          console.log(`SESSION_ID=${sessionString}`);
          console.log(`SESSION_PASSWORD=${password}`);
          console.log("");
          process.exit(0);
        } catch (e) {
          console.error(chalk.red(e.message));
        }
      }
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(chalk.red(`Bağlantı kəsildi. Səbəb kodu: ${statusCode || "naməlum"}`));

      if (shouldReconnect) {
        console.log(chalk.yellow("Yenidən qoşulur..."));
        startBot();
      } else {
        console.log(chalk.red("Login çıxarıldı. Yenidən pair lazımdır."));
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    if (!remoteJid || remoteJid === "status@broadcast") return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      "";

    if (!text.startsWith(COMMAND_PREFIX)) return;

    const args = text.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
    const commandName = (args.shift() || "").toLowerCase();

    const command = commands.get(commandName);
    if (!command) return;

    try {
      await command.execute(sock, msg, args);
    } catch (e) {
      await sock.sendMessage(
        remoteJid,
        { text: `Xəta baş verdi: ${e.message || e}` },
        { quoted: msg }
      );
    }
  });
}

(async () => {
  try {
    await startBot();
  } catch (e) {
    console.error(chalk.red("Start xətası:"), e?.message || e);
    process.exit(1);
  }
})();
