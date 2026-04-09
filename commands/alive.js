export default {
  name: "alive",
  description: "Bot status",
  async execute(sock, msg) {
    await sock.sendMessage(
      msg.key.remoteJid,
      { text: "HUSEYN-MD işləyir ✅" },
      { quoted: msg }
    );
  }
};
