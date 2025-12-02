const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  EmbedBuilder
} = require("discord.js");

// ================== CONFIG ==================
const TOKEN = process.env.TOKEN;
const ABSEN_CHANNEL_ID = process.env.ABSEN_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
// ============================================

// Inisialisasi client/bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ==== Helper: format waktu ke zona Asia/Jakarta ====
function formatWaktuJakarta(date = new Date()) {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

// Helper: ambil “tanggal saja” (dd/mm/yyyy) di zona Asia/Jakarta
function getTanggalJakarta(date = new Date()) {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date); // contoh: 02/12/2025
}

// ==== Helper: bikin tombol ON/OFF ====
function createDutyButtons() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("on_duty")
      .setLabel("🟢 ON DUTY")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("off_duty")
      .setLabel("🔴 OFF DUTY")
      .setStyle(ButtonStyle.Danger)
  );

  return row;
}

// ==== Saat bot online ====
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    const absenChannel = await client.channels.fetch(ABSEN_CHANNEL_ID);

    // Embed info di channel absensi
    const infoEmbed = new EmbedBuilder()
      .setColor(0x1abc9c)
      .setTitle("📋 Panel Absensi Duty")
      .setDescription(
        "Gunakan tombol di bawah untuk mencatat status duty kamu.\n\n" +
        "• Klik **ON DUTY** saat mulai bertugas.\n" +
        "• Klik **OFF DUTY** saat selesai bertugas.\n\n" +
        "Seluruh aktivitas akan tercatat otomatis di channel log."
      )
      .setFooter({ text: "Sistem Absensi Duty by Falcon 01" })
      .setTimestamp();

    await absenChannel.send({
      embeds: [infoEmbed],
      components: [createDutyButtons()]
    });

    console.log("✅ Panel absensi dikirim ke channel absensi.");
  } catch (err) {
    console.error("❌ Gagal kirim panel absensi:", err);
  }
});

// ==== Helper: ambil semua pesan di log channel sejak tanggal tertentu ====
async function fetchMessagesSince(channel, sinceDate) {
  let allMessages = [];
  let lastId = null;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;

    const filtered = [...messages.values()].filter(
      (m) => m.createdAt >= sinceDate
    );

    allMessages.push(...filtered);

    const oldest = [...messages.values()].reduce((a, b) =>
      a.createdTimestamp < b.createdTimestamp ? a : b
    );

    if (oldest.createdAt < sinceDate) break;

    lastId = oldest.id;
  }

  return allMessages;
}

// ==== Helper: ambil event ON/OFF user di 7 hari terakhir dari log ====
async function getUserEventsLast7Days(logChannel, userId, now) {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const messages = await fetchMessagesSince(logChannel, weekAgo);

  const events = messages
    .filter((m) => m.author.id === client.user.id) // pesan dari bot
    .map((m) => {
      const embed = m.embeds[0];
      if (!embed) return null;

      const fields = embed.fields || [];
      const userField = fields.find((f) => f.name === "User");
      const statusField = fields.find((f) => f.name === "Status");

      if (!userField || !statusField) return null;

      // Cek apakah embed ini untuk user yang diminta (pakai mention id)
      if (!userField.value.includes(userId)) return null;

      let type = null;
      if (statusField.value.toUpperCase().includes("ON DUTY")) type = "on";
      else if (statusField.value.toUpperCase().includes("OFF DUTY")) type = "off";

      if (!type) return null;

      return {
        type,
        time: m.createdAt
      };
    })
    .filter((e) => e !== null)
    .sort((a, b) => a.time - b.time);

  return events;
}

// ==== Helper: ambil SEMUA event user (map) dalam 7 hari terakhir ====
async function getAllUserEventsLast7Days(logChannel, now) {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const messages = await fetchMessagesSince(logChannel, weekAgo);

  /** @type {Map<string, {type: 'on'|'off', time: Date}[]>} */
  const map = new Map();

  for (const m of messages) {
    if (m.author.id !== client.user.id) continue;
    const embed = m.embeds[0];
    if (!embed) continue;

    const fields = embed.fields || [];
    const userField = fields.find((f) => f.name === "User");
    const statusField = fields.find((f) => f.name === "Status");

    if (!userField || !statusField) continue;

    // Ambil userId dari mention <@123> atau <@!123>
    const match = userField.value.match(/<@!?(\d+)>/);
    if (!match) continue;
    const userId = match[1];

    let type = null;
    if (statusField.value.toUpperCase().includes("ON DUTY")) type = "on";
    else if (statusField.value.toUpperCase().includes("OFF DUTY")) type = "off";
    if (!type) continue;

    if (!map.has(userId)) map.set(userId, []);
    map.get(userId).push({ type, time: m.createdAt });
  }

  // sort per user
  for (const [, events] of map) {
    events.sort((a, b) => a.time - b.time);
  }

  return map;
}

// ==== Helper: hitung statistik duty dari list event ====
function calculateDutyStats(events, now) {
  let currentOn = null;
  let totalMs = 0;       // total 7 hari
  let totalMsDay = 0;    // total hari ini
  let sessionCount = 0;
  const attendanceDays = new Set(); // tanggal kehadiran (berdasar waktu mulai)

  const todayStr = getTanggalJakarta(now);

  for (const ev of events) {
    if (ev.type === "on") {
      if (!currentOn) {
        currentOn = ev.time;
      }
    } else if (ev.type === "off") {
      if (currentOn) {
        const end = ev.time;
        const durationMs = end - currentOn;

        totalMs += durationMs;
        sessionCount++;

        // tanggal kehadiran berdasarkan waktu mulai
        const tanggalKehadiran = getTanggalJakarta(currentOn);
        attendanceDays.add(tanggalKehadiran);

        // jika sesi berakhir hari ini, masuk ke totalMsDay
        const endDateStr = getTanggalJakarta(end);
        if (endDateStr === todayStr) {
          totalMsDay += durationMs;
        }

        currentOn = null;
      }
    }
  }

  return {
    totalMs,        // total ms dalam 7 hari
    totalMsDay,     // total ms hari ini
    sessionCount,
    attendanceDays  // Set tanggal
  };
}

// ==== Handle klik tombol ====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
  const user = interaction.user;
  const member = interaction.member; // member di server (untuk nama server profile)

  // Nama tampilan: prioritas server nickname, lalu globalName/username
  const displayName =
    member?.displayName || user.globalName || user.username;

  const waktu = formatWaktuJakarta();

  // ========== ON DUTY ==========
  if (interaction.customId === "on_duty") {
    const logEmbed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setAuthor({
        name: displayName,
        iconURL: user.displayAvatarURL({ size: 128 })
      })
      .setTitle("🟢 Log Duty")
      .addFields(
        {
          name: "User",
          value: `${member}`, // mention user
          inline: true
        },
        {
          name: "Status",
          value: "ON DUTY",
          inline: true
        },
        {
          name: "Waktu (WIB)",
          value: waktu,
          inline: false
        }
      )
      .setFooter({ text: "Sistem Absensi Duty - Log Otomatis" })
      .setTimestamp();

    await logChannel.send({ embeds: [logEmbed] });

    const replyEmbed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle("🟢 Status Duty Diperbarui")
      .setDescription(
        `Halo, **${displayName}**!\n` +
        `Status duty kamu telah diperbarui menjadi **ON DUTY**.`
      )
      .addFields(
        {
          name: "Waktu (WIB)",
          value: waktu,
          inline: false
        },
        {
          name: "Catatan",
          value: "Jangan lupa klik **OFF DUTY** setelah kamu selesai bertugas."
        }
      )
      .setThumbnail(user.displayAvatarURL({ size: 128 }))
      .setFooter({ text: "Informasi ini hanya terlihat oleh kamu." })
      .setTimestamp();

    await interaction.reply({
      embeds: [replyEmbed],
      ephemeral: true
    });

    return;
  }

  // ========== OFF DUTY ==========
  if (interaction.customId === "off_duty") {
    const now = new Date();

    // Ambil semua event user ini dalam 7 hari terakhir
    const events = await getUserEventsLast7Days(logChannel, user.id, now);

    // Tambahkan event OFF yang baru (belum tercatat di log channel)
    events.push({ type: "off", time: now });
    events.sort((a, b) => a.time - b.time);

    // Hitung statistik
    const { totalMs, totalMsDay } = calculateDutyStats(events, now);
    const hoursWeek = totalMs / (1000 * 60 * 60);
    const hoursDay = totalMsDay / (1000 * 60 * 60);

    const logEmbed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setAuthor({
        name: displayName,
        iconURL: user.displayAvatarURL({ size: 128 })
      })
      .setTitle("🔴 Log Duty")
      .addFields(
        {
          name: "User",
          value: `${member}`,
          inline: true
        },
        {
          name: "Status",
          value: "OFF DUTY",
          inline: true
        },
        {
          name: "Waktu (WIB)",
          value: waktu,
          inline: false
        },
        {
          name: "Total Durasi Hari Ini",
          value: `${hoursDay.toFixed(2)} jam`,
          inline: false
        },
        {
          name: "Total Durasi 7 Hari Terakhir",
          value: `${hoursWeek.toFixed(2)} jam`,
          inline: false
        }
      )
      .setFooter({ text: "Sistem Absensi Duty - Log Otomatis" })
      .setTimestamp();

    await logChannel.send({ embeds: [logEmbed] });

    const replyEmbed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle("🔴 Status Duty Diperbarui")
      .setDescription(
        `Halo, **${displayName}**!\n` +
        `Status duty kamu telah diperbarui menjadi **OFF DUTY**.`
      )
      .addFields(
        {
          name: "Waktu (WIB)",
          value: waktu,
          inline: false
        },
        {
          name: "Durasi Hari Ini",
          value: `${hoursDay.toFixed(2)} jam`,
          inline: true
        },
        {
          name: "Durasi 7 Hari Terakhir",
          value: `${hoursWeek.toFixed(2)} jam`,
          inline: true
        },
        {
          name: "Catatan",
          value: "Terima kasih, duty kamu sudah tercatat di sistem."
        }
      )
      .setThumbnail(user.displayAvatarURL({ size: 128 }))
      .setFooter({ text: "Informasi ini hanya terlihat oleh kamu." })
      .setTimestamp();

    await interaction.reply({
      embeds: [replyEmbed],
      ephemeral: true
    });

    return;
  }
});

// ==== Command teks (weekly & weeklyall) ====
// - !weekly @user    -> rekap per user 7 hari terakhir
// - !weeklyall       -> rekap semua user 7 hari terakhir
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const lower = content.toLowerCase();

  // Pastikan hanya admin
  if (
    lower.startsWith("!weekly") &&
    !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
  ) {
    await message.reply("Kamu tidak punya izin untuk pakai command ini (admin only).");
    return;
  }

    // ========== !weeklyall ==========
  if (lower.startsWith("!weeklyall")) {
    try {
      const now = new Date();
      const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);

      const allMap = await getAllUserEventsLast7Days(logChannel, now);

      // hitung stats per user
      const results = [];
      for (const [userId, events] of allMap.entries()) {
        const { totalMs, sessionCount, attendanceDays } = calculateDutyStats(events, now);
        if (sessionCount === 0) continue;

        const hours = totalMs / (1000 * 60 * 60);
        results.push({
          userId,
          hours,
          sessionCount,
          attendanceDaysCount: attendanceDays.size
        });
      }

      if (results.length === 0) {
        await message.reply("Tidak ada data duty dalam 7 hari terakhir.");
        return;
      }

      // urutkan dari total jam terbesar
      results.sort((a, b) => b.hours - a.hours);

      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const periodeText = `${formatWaktuJakarta(weekAgo)} s/d ${formatWaktuJakarta(now)}`;

      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle("📊 Rekap Duty 7 Hari Terakhir (Semua User)")
        .setDescription(
          "Ringkasan aktivitas duty semua user dalam 7 hari terakhir.\n" +
          "Diurutkan berdasarkan **total jam duty** tertinggi."
        )
        .addFields({
          name: "Periode",
          value: periodeText,
          inline: false
        })
        .setFooter({ text: "Sistem Absensi Duty - Rekap Mingguan Global" })
        .setTimestamp();

      // Discord embed max 25 fields, sisakan 1 utk periode → pakai max 24 user
      const maxUsers = 24;
      const sliced = results.slice(0, maxUsers);

      // Ambil semua member sekaligus (kalau bisa)
      const userIds = sliced.map((r) => r.userId);
      let membersMap = null;
      try {
        // fetch kolektif
        membersMap = await message.guild.members.fetch({ user: userIds });
      } catch {
        membersMap = null;
      }

      for (const r of sliced) {
        // cari member di hasil fetch atau di cache
        const member =
          (membersMap && membersMap.get(r.userId)) ||
          message.guild.members.cache.get(r.userId);

        const displayName =
          member?.displayName ||
          member?.user?.globalName ||
          member?.user?.username ||
          `User ${r.userId}`;

        embed.addFields({
          name: displayName, // hanya nama, tanpa mention/id
          value:
            `• Kehadiran: **${r.attendanceDaysCount}** hari\n` +
            `• Sesi duty: **${r.sessionCount}**\n` +
            `• Total durasi: **${r.hours.toFixed(2)} jam**`,
          inline: false
        });
      }

      if (results.length > maxUsers) {
        embed.addFields({
          name: "Info",
          value: `Hanya menampilkan ${maxUsers} user teratas dari total ${results.length} user.`,
          inline: false
        });
      }

      await message.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await message.reply("Terjadi error saat membaca log absensi global.");
    }

    return;
  }


  // ========== !weekly @user ==========
  if (lower.startsWith("!weekly")) {
    const mentionedMember = message.mentions.members.first();
    if (!mentionedMember) {
      await message.reply("Tolong mention user yang mau dicek. Contoh: `!weekly @User`");
      return;
    }

    const targetUser = mentionedMember.user;
    const now = new Date();

    try {
      const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);

      const events = await getUserEventsLast7Days(logChannel, targetUser.id, now);
      const { totalMs, sessionCount, attendanceDays } = calculateDutyStats(events, now);

      const totalHours = totalMs / (1000 * 60 * 60);
      const totalKehadiran = attendanceDays.size;

      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const periodeText = `${formatWaktuJakarta(weekAgo)} s/d ${formatWaktuJakarta(now)}`;

      const summaryEmbed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle("📊 Rekap Duty 7 Hari Terakhir (Per User)")
        .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
        .addFields(
          {
            name: "User",
            value: `${mentionedMember}`,
            inline: false
          },
          {
            name: "Periode",
            value: periodeText,
            inline: false
          },
          {
            name: "Total Kehadiran (hari)",
            value: `${totalKehadiran} hari`,
            inline: true
          },
          {
            name: "Total Sesi Duty",
            value: `${sessionCount} sesi`,
            inline: true
          },
          {
            name: "Total Durasi",
            value: `${totalHours.toFixed(2)} jam`,
            inline: true
          },
          {
            name: "Sumber Data",
            value: `Dihitung dari log di <#${LOG_CHANNEL_ID}> (1 hari = 1 kehadiran)`,
            inline: false
          }
        )
        .setFooter({ text: "Sistem Absensi Duty - Rekap Mingguan" })
        .setTimestamp();

      await message.reply({ embeds: [summaryEmbed] });
    } catch (err) {
      console.error(err);
      await message.reply("Terjadi error saat membaca log absensi.");
    }

    return;
  }
});

// ==== Jalankan bot ====
client.login(TOKEN);


