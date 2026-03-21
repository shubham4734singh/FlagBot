require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
  PermissionFlagsBits, 
  EmbedBuilder, 
  Colors, 
  ChannelType,
  MessageFlags,
  Events
} = require("discord.js");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

/* ================= CONFIGURATION ================= */
const ADMIN_ID = process.env.ADMIN_ID || "843351441664901121"; 
const ROLE_PREFIX = "CTF";
const CHANNELS = {
    ANNOUNCEMENTS: "ctf-announcements"
};


/* ================= CLIENT SETUP ================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages, // Optional if we only use interactions, but good for caching
    // GatewayIntentBits.MessageContent // NOT REQUIRED for Slash Commands
  ]
});

/* ================= DATABASE SETUP ================= */
const db = new sqlite3.Database("ctf.db");

function initDB() {
  db.serialize(() => {
        // CTF Events (multiple active)
        db.run(`CREATE TABLE IF NOT EXISTS ctfs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            url TEXT,
            format TEXT,
            start INTEGER,
            end INTEGER,
            status TEXT,
            room_channel_id TEXT,
            flags_channel_id TEXT,
            role_id TEXT
        )`);

        // Backward-compatible columns (ignore errors if they already exist)
        db.run("ALTER TABLE ctfs ADD COLUMN room_channel_id TEXT", () => {});
        db.run("ALTER TABLE ctfs ADD COLUMN flags_channel_id TEXT", () => {});
        db.run("ALTER TABLE ctfs ADD COLUMN role_id TEXT", () => {});

        // Joined Users per CTF
        db.run(`CREATE TABLE IF NOT EXISTS joined_ctf (
            user_id TEXT,
            ctf_id INTEGER,
            joined_at INTEGER,
            PRIMARY KEY (user_id, ctf_id)
        )`);

        // Flag Submissions (unique per CTF)
        db.run(`CREATE TABLE IF NOT EXISTS flags_ctf (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            challenge TEXT,
            category TEXT,
            flag TEXT,
            timestamp INTEGER,
            ctf_event_id INTEGER,
            UNIQUE (flag, ctf_event_id)
        )`);

        // OTP System per CTF
        db.run(`CREATE TABLE IF NOT EXISTS otp_ctf (
            user_id TEXT,
            ctf_id INTEGER,
            code TEXT,
            expires_at INTEGER,
            PRIMARY KEY (user_id, ctf_id)
        )`);
  });
}
initDB();

/* ================= HELPERS ================= */

// Generate 6-digit OTP
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function getCtfRoleName(ctfName) {
    const base = (ctfName || "CTF").trim();
    const name = `${ROLE_PREFIX} ${base}`.replace(/\s+/g, " ");
    return name.length > 100 ? name.slice(0, 100) : name;
}

// Get or Create Per-CTF Role
async function getOrCreateCtfRole(guild, ctfName, storedRoleId) {
    let role = storedRoleId ? guild.roles.cache.get(storedRoleId) : null;
    if (!role) {
        const roleName = getCtfRoleName(ctfName);
        role = guild.roles.cache.find(r => r.name === roleName) || null;
    }

    if (!role) {
        role = await guild.roles.create({
            name: getCtfRoleName(ctfName),
            color: Colors.Green,
            reason: "CTF Player Role"
        });
    }
    return role;
}

function sanitizeChannelSlug(name) {
    const parts = (name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .split("_")
        .filter(Boolean)
        .filter(part => part !== "ctf");

    return parts.join("_") || "event";
}

function getCtfChannelNames(ctfName) {
    const base = sanitizeChannelSlug(ctfName);
    return {
        room: `ctf_${base}`,
        flags: `ctf_${base}_flags`
    };
}

// Ensure Channels Exist
async function ensureCtfChannels(guild, role, ctfName, storedIds) {
  const channelExists = (name) => guild.channels.cache.find(c => c.name === name);
    const channelById = (id) => (id ? guild.channels.cache.get(id) : null);

  const names = getCtfChannelNames(ctfName);

  // 2. Per-CTF Room (Player+Admin Read/Write, Public Deny)
  let roomChannel = channelById(storedIds?.room_channel_id) || channelExists(names.room);
  if (!roomChannel) {
        roomChannel = await guild.channels.create({
            name: names.room,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
        });
  }

  // 3. Per-CTF Flags Log (Player Read, Bot Write)
  let flagsChannel = channelById(storedIds?.flags_channel_id) || channelExists(names.flags);
  if (!flagsChannel) {
        flagsChannel = await guild.channels.create({
            name: names.flags,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: role.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
        });
  }

  // FORCE UPDATES: Ensure CTF_PLAYER role cannot send messages in Announcement
  const readOnlyChannels = [CHANNELS.ANNOUNCEMENTS];
  for (const name of readOnlyChannels) {
        const ch = guild.channels.cache.find(c => c.name === name);
        if (ch) {
            await ch.permissionOverwrites.edit(role.id, { 
                SendMessages: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
                AddReactions: true // Allow reactions
            });
        }
  }

    return { roomChannel, flagsChannel };
}

async function ensureAnnouncementsChannel(guild) {
    const channelExists = (name) => guild.channels.cache.find(c => c.name === name);
    if (!channelExists(CHANNELS.ANNOUNCEMENTS)) {
        await guild.channels.create({
            name: CHANNELS.ANNOUNCEMENTS,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                { id: client.user.id, allow: [PermissionFlagsBits.SendMessages] }
            ]
        });
    }
}

// Parse Date String (Basic ISO attempt or YYYY-MM-DD HH:MM)
function parseDate(input) {
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.getTime();
}

function getCtfByName(name, callback) {
    db.get(
        "SELECT * FROM ctfs WHERE lower(name)=lower(?) ORDER BY id DESC LIMIT 1",
        [name],
        callback
    );
}

function buildCtfAnnouncementEmbed(ctf, titlePrefix = "📢 CTF Announcement") {
    return new EmbedBuilder()
        .setTitle(`${titlePrefix} – ${ctf.name}`)
        .setColor(Colors.Blue)
        .setDescription(`------------------------------------------------------------------\n🔹 **Format**: ${ctf.format}\n🔹 **Official URL**: ${ctf.url}\n\n🕒 **Schedule**:\n📆 Start: <t:${Math.floor(ctf.start/1000)}:F> (<t:${Math.floor(ctf.start/1000)}:R>)\n📆 End: <t:${Math.floor(ctf.end/1000)}:F> (<t:${Math.floor(ctf.end/1000)}:R>)\n------------------------------------------------------------------`)
        .addFields(
            { name: "Join Team", value: `🔗 [Click here to join team](${ctf.url})` }
        )
        .setFooter({ text: "Use /join_ctf to access bot channels." });
}

function buildFinalResultsEmbed(ctf, rows, solverCount, flagCount) {
    const medals = ["🥇", "🥈", "🥉"];
    let desc = "";

    if (!rows || rows.length === 0) {
        desc = "No solves recorded.";
    } else {
        rows.forEach((row, index) => {
            const prefix = medals[index] || `**${index + 1}.**`;
            desc += `${prefix} <@${row.user_id}> — **${row.score} flags**\n`;
        });
    }

    return new EmbedBuilder()
        .setTitle(`🏁 CTF ENDED: ${ctf.name}`)
        .setColor(Colors.Gold)
        .setDescription(desc)
        .addFields(
            { name: "Stats", value: `👥 Solvers: ${solverCount || 0}\n🚩 Total Flags: ${flagCount || 0}` }
        )
        .setTimestamp();
}

async function finalizeCtf(ctf, guild) {
    const eventId = ctf.id;

    const run = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });

    const all = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });

    const get = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });

    await run("UPDATE ctfs SET status='ended' WHERE id=?", [eventId]);

    const rows = await all(
        `SELECT user_id, COUNT(*) as score
         FROM flags_ctf
         WHERE ctf_event_id=?
         GROUP BY user_id
         ORDER BY score DESC, MIN(timestamp) ASC
         LIMIT 10`,
        [eventId]
    );

    const solverRow = await get(
        "SELECT COUNT(DISTINCT user_id) as count FROM flags_ctf WHERE ctf_event_id=?",
        [eventId]
    );
    const flagRow = await get(
        "SELECT COUNT(*) as count FROM flags_ctf WHERE ctf_event_id=?",
        [eventId]
    );

    const embed = buildFinalResultsEmbed(ctf, rows, solverRow?.count, flagRow?.count);

    const announcementChannel = guild.channels.cache.find(c => c.name === CHANNELS.ANNOUNCEMENTS);
    if (announcementChannel) {
        await announcementChannel.send({ embeds: [embed] });
    }

    const roomChannel = ctf.room_channel_id ? guild.channels.cache.get(ctf.room_channel_id) : null;
    if (roomChannel) {
        await roomChannel.send({ embeds: [embed] });
        if (ctf.role_id) {
            await roomChannel.permissionOverwrites.edit(ctf.role_id, {
                ViewChannel: true,
                SendMessages: false,
                AddReactions: true
            });
        }
    }

    const flagsChannel = ctf.flags_channel_id ? guild.channels.cache.get(ctf.flags_channel_id) : null;
    if (flagsChannel && ctf.role_id) {
        await flagsChannel.permissionOverwrites.edit(ctf.role_id, {
            ViewChannel: true,
            SendMessages: false,
            AddReactions: true
        });
    }
}

async function deleteCtfData(ctf, guild) {
    const run = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });

    const roomChannel = ctf.room_channel_id ? guild.channels.cache.get(ctf.room_channel_id) : null;
    const flagsChannel = ctf.flags_channel_id ? guild.channels.cache.get(ctf.flags_channel_id) : null;
    const role = ctf.role_id ? guild.roles.cache.get(ctf.role_id) : null;

    if (roomChannel) {
        await roomChannel.delete("CTF deleted by admin").catch(() => {});
    }
    if (flagsChannel) {
        await flagsChannel.delete("CTF deleted by admin").catch(() => {});
    }
    if (role) {
        await role.delete("CTF deleted by admin").catch(() => {});
    }

    await run("DELETE FROM otp_ctf WHERE ctf_id=?", [ctf.id]);
    await run("DELETE FROM joined_ctf WHERE ctf_id=?", [ctf.id]);
    await run("DELETE FROM flags_ctf WHERE ctf_event_id=?", [ctf.id]);
    await run("DELETE FROM ctfs WHERE id=?", [ctf.id]);
}

async function autoFinalizeExpiredCtfs() {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    db.all(
        "SELECT * FROM ctfs WHERE status != 'ended' AND end <= ?",
        [Date.now()],
        async (err, rows) => {
            if (err || !rows || rows.length === 0) return;

            for (const ctf of rows) {
                try {
                    await finalizeCtf(ctf, guild);
                } catch (error) {
                    console.error("Auto finalize failed:", ctf.name, error);
                }
            }
        }
    );
}

/* ================= INTERACTION HANDLER ================= */

client.once(Events.ClientReady, () => {
    console.log(`✅ ${client.user.tag} Online & Ready.`);
    autoFinalizeExpiredCtfs();
    setInterval(autoFinalizeExpiredCtfs, 60 * 1000);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  /* ------------------ CTF ADMIN: CREATE ------------------ */
  if (commandName === "create_ctf") {
    if (interaction.user.id !== ADMIN_ID) {
        return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
    }

    const name = interaction.options.getString("name");
    const startStr = interaction.options.getString("start_datetime");
    const endStr = interaction.options.getString("end_datetime");
    const url = interaction.options.getString("official_url") || "N/A";
    const format = interaction.options.getString("format") || "Jeopardy";

    const start = parseDate(startStr);
    const end = parseDate(endStr);

    if (!start || !end) {
        return interaction.reply({ content: "❌ Invalid Date Format. Use ISO 8601 (e.g. 2026-02-09T10:00:00)", ephemeral: true });
    }

    if (end <= start) {
        return interaction.reply({ content: "❌ End time must be after Start time.", ephemeral: true });
    }

    await interaction.deferReply();
    await ensureAnnouncementsChannel(interaction.guild);

    db.run(
        `INSERT INTO ctfs (name, url, format, start, end, status, room_channel_id, flags_channel_id, role_id)
         VALUES (?, ?, ?, ?, ?, 'scheduled', NULL, NULL, NULL)`,
        [name, url, format, start, end],
        async function(err) {
            if (err) {
                console.error(err);
                return interaction.editReply({ content: "❌ Database Error." });
            }

            const annChannel = interaction.guild.channels.cache.find(c => c.name === CHANNELS.ANNOUNCEMENTS);

            const embed = buildCtfAnnouncementEmbed({
                name,
                format,
                url,
                start,
                end
            });

            if (annChannel) {
                await annChannel.send({ content: "@everyone", embeds: [embed] });
            } else {
                await interaction.channel?.send({ content: "@everyone", embeds: [embed] });
            }

                        interaction.editReply(`✅ **${name}** Created & Announced!`);
        }
    );
  }

  /* ------------------ CTF ADMIN: EDIT ------------------ */
  if (commandName === "edit_ctf") {
    if (interaction.user.id !== ADMIN_ID) {
        return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
    }

    const ctfName = interaction.options.getString("name");
    const startStr = interaction.options.getString("start_datetime");
    const endStr = interaction.options.getString("end_datetime");
    const newUrl = interaction.options.getString("official_url");
    const newFormat = interaction.options.getString("format");

    if (!startStr && !endStr && !newUrl && !newFormat) {
        return interaction.reply({ content: "Provide at least one field to update.", ephemeral: true });
    }

    return getCtfByName(ctfName, async (err, ctf) => {
        if (!ctf) {
            return interaction.reply({ content: "CTF not found.", ephemeral: true });
        }

        const nextStart = startStr ? parseDate(startStr) : ctf.start;
        const nextEnd = endStr ? parseDate(endStr) : ctf.end;

        if ((startStr && !nextStart) || (endStr && !nextEnd)) {
            return interaction.reply({ content: "Invalid date format. Use ISO 8601 like 2026-02-09T10:00:00", ephemeral: true });
        }

        if (nextEnd <= nextStart) {
            return interaction.reply({ content: "End time must be after start time.", ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const updated = {
            ...ctf,
            start: nextStart,
            end: nextEnd,
            url: newUrl || ctf.url,
            format: newFormat || ctf.format
        };

        db.run(
            "UPDATE ctfs SET url=?, format=?, start=?, end=? WHERE id=?",
            [updated.url, updated.format, updated.start, updated.end, ctf.id],
            async (updateErr) => {
                if (updateErr) {
                    console.error(updateErr);
                    return interaction.editReply({ content: "Failed to update this CTF." });
                }

                try {
                    await ensureAnnouncementsChannel(interaction.guild);
                    const annChannel = interaction.guild.channels.cache.find(c => c.name === CHANNELS.ANNOUNCEMENTS);
                    const embed = buildCtfAnnouncementEmbed(updated, "🛠️ CTF Updated");

                    if (annChannel) {
                        await annChannel.send({ embeds: [embed] });
                    } else {
                        await interaction.channel?.send({ embeds: [embed] });
                    }

                    return interaction.editReply({ content: `Updated **${ctf.name}** successfully.` });
                } catch (postErr) {
                    console.error(postErr);
                    return interaction.editReply({ content: `Updated **${ctf.name}**, but failed to post the update announcement.` });
                }
            }
        );
    });
  }

  /* ------------------ CTF ADMIN: END ------------------ */
  if (commandName === "end_ctf") {
    if (interaction.user.id !== ADMIN_ID) {
        return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
    }

    const ctfName = interaction.options.getString("name");
    if (!ctfName) {
        return interaction.reply({ content: "❌ CTF name is required. Update commands and run /end_ctf name:CTF_NAME", ephemeral: true });
    }

    getCtfByName(ctfName, async (err, ctf) => {
        if (!ctf) return interaction.reply({ content: "CTF not found.", ephemeral: true });
        await interaction.deferReply();

        try {
            await finalizeCtf(ctf, interaction.guild);
            return interaction.editReply("CTF ended. Results published to the event room and announcements.");
        } catch (error) {
            console.error(error);
            return interaction.editReply("Failed to finalize this CTF.");
        }
    });
  }

  /* ------------------ CTF ADMIN: DELETE ------------------ */
  if (commandName === "delete_ctf") {
      if (interaction.user.id !== ADMIN_ID) {
          return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
      }

      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "CTF name is required.", ephemeral: true });
      }

      return getCtfByName(ctfName, async (err, ctf) => {
          if (!ctf) {
              return interaction.reply({ content: "CTF not found.", ephemeral: true });
          }

          await interaction.deferReply({ ephemeral: true });

          try {
              await deleteCtfData(ctf, interaction.guild);
              return interaction.editReply(`Deleted **${ctf.name}** from the database and removed its bot-managed channels/role if they existed.`);
          } catch (error) {
              console.error(error);
              return interaction.editReply("Failed to delete this CTF.");
          }
      });
  }

  /* ------------------ CTF ADMIN: ALL FLAGS ------------------ */
  if (commandName === "allflags") {
      if (interaction.user.id !== ADMIN_ID) {
          return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
      }

      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "❌ CTF name is required. Update commands and run /allflags name:CTF_NAME", ephemeral: true });
      }

      getCtfByName(ctfName, (err, ctf) => {
          if (!ctf) {
              return interaction.reply({ content: "CTF not found.", ephemeral: true });
          }

          db.all("SELECT * FROM flags_ctf WHERE ctf_event_id=? ORDER BY timestamp DESC", [ctf.id], (err, rows) => {
              if (!rows || rows.length === 0) return interaction.reply({ content: "No flags submitted yet.", ephemeral: true });

              let output = "**🚩 All Submitted Flags**\n\n";
              rows.forEach((r, i) => {
                  const line = `${i+1}. <@${r.user_id}> | **${r.challenge}** (${r.category}) | \`${r.flag}\`\n`;
                  if (output.length + line.length < 2000) {
                      output += line;
                  }
              });

              if (rows.length > 20 && output.length >= 1900) {
                  output += `\n... ${rows.length - 20} more flags hidden (limit reached).`;
              }

              interaction.reply({ content: output, ephemeral: true });
          });
      });
  }


  /* ------------------ USER: JOIN (OTP GEN) ------------------ */
  if (commandName === "join_ctf") {
      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "❌ CTF name is required. Update commands and run /join_ctf name:CTF_NAME", ephemeral: true });
      }

      getCtfByName(ctfName, (err, ctf) => {
        if (!ctf || ctf.status === 'ended') {
             return interaction.reply({ content: "🚫 CTF not found or already ended.", ephemeral: true });
        }

        db.get("SELECT * FROM joined_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id], (err, row) => {
            if (row) {
                return interaction.reply({ content: "✅ You have already joined!", ephemeral: true });
            }

            const otp = generateOTP();
            const expires = Date.now() + 5 * 60 * 1000; // 5 mins

            db.run(
              "INSERT OR REPLACE INTO otp_ctf (user_id, ctf_id, code, expires_at) VALUES (?, ?, ?, ?)",
              [interaction.user.id, ctf.id, otp, expires],
              (err) => {
                  if (err) console.error(err);
                  
                  const msg = `🏆 **${ctf.name}**\n🔐 **Verification Required**\nYour OTP is: \`${otp}\``;
                  
                  interaction.reply({ 
                      content: `${msg}\n\nRun command: \`/verify_otp name:${ctf.name} code:${otp}\`\n(Valid for 5 minutes)`,
                      ephemeral: true 
                  });
              }
            );
        });
      });
  }

  /* ------------------ USER: LIST CTF ------------------ */
  if (commandName === "list_ctf") {
      const now = Date.now();

      return db.all(
        "SELECT * FROM ctfs WHERE status != 'ended' ORDER BY start ASC",
        [],
        (err, rows) => {
            if (err) {
                console.error(err);
                return interaction.reply({ content: "Failed to load CTF list.", ephemeral: true });
            }

            if (!rows || rows.length === 0) {
                return interaction.reply({ content: "No active or upcoming CTF events found.", ephemeral: true });
            }

            const desc = rows.map((ctf, index) => {
                let status = "Upcoming";
                if (now >= ctf.start && now <= ctf.end) status = "Live";
                if (now > ctf.end) status = "Ending soon";

                return [
                    `**${index + 1}. ${ctf.name}**`,
                    `Status: ${status}`,
                    `Start: <t:${Math.floor(ctf.start / 1000)}:F>`,
                    `End: <t:${Math.floor(ctf.end / 1000)}:F>`,
                    `Format: ${ctf.format || "Unknown"}`,
                    `Join with: \`/join_ctf name:${ctf.name}\``
                ].join("\n");
            }).join("\n\n");

            const embed = new EmbedBuilder()
                .setTitle("Available CTF Events")
                .setColor(Colors.Blue)
                .setDescription(desc)
                .setTimestamp();

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
      );
  }

  /* ------------------ USER: LEAVE CTF ------------------ */
  if (commandName === "leave_ctf") {
      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "CTF name is required.", ephemeral: true });
      }

      return getCtfByName(ctfName, (err, ctf) => {
          if (!ctf) {
              return interaction.reply({ content: "CTF not found.", ephemeral: true });
          }

          db.get("SELECT * FROM joined_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id], async (err, joinedRow) => {
              if (!joinedRow) {
                  return interaction.reply({ content: "You are not part of this CTF.", ephemeral: true });
              }

              db.run("DELETE FROM joined_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id]);
              db.run("DELETE FROM otp_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id]);

              try {
                  if (ctf.role_id) {
                      const member = await interaction.guild.members.fetch(interaction.user.id);
                      await member.roles.remove(ctf.role_id).catch(() => {});
                  }

                  const roomMention = ctf.room_channel_id ? `<#${ctf.room_channel_id}>` : `**${ctf.name}**`;
                  return interaction.reply({
                      content: `You left **${ctf.name}**. Your access to ${roomMention} has been removed.`,
                      ephemeral: true
                  });
              } catch (error) {
                  console.error(error);
                  return interaction.reply({ content: "You were removed from the CTF, but role cleanup failed.", ephemeral: true });
              }
          });
      });
  }

  /* ------------------ USER: VERIFY OTP ------------------ */
  if (commandName === "verify_otp") {
      await interaction.deferReply({ ephemeral: true }); // Prevent timeout
      const ctfName = interaction.options.getString("name");
      const code = interaction.options.getString("code");

      return getCtfByName(ctfName, (err, ctf) => {
          if (!ctf || ctf.status === "ended") {
              return interaction.editReply({ content: "CTF not found or already ended." });
          }

          db.get(
            "SELECT * FROM otp_ctf WHERE user_id=? AND ctf_id=? AND code=?",
            [interaction.user.id, ctf.id, code.trim()],
            (err, otpRow) => {
                if (!otpRow) {
                    return interaction.editReply({ content: "Invalid OTP for this CTF. Run `/join_ctf` again." });
                }

                if (Date.now() > otpRow.expires_at) {
                    db.run("DELETE FROM otp_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, otpRow.ctf_id]);
                    return interaction.editReply({ content: "OTP expired. Run `/join_ctf` again." });
                }

                db.get("SELECT * FROM joined_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id], async (err, joinedRow) => {
                    if (joinedRow) {
                        return interaction.editReply({ content: "You are already a player." });
                    }

                    db.run(
                      "INSERT OR REPLACE INTO joined_ctf (user_id, ctf_id, joined_at) VALUES (?, ?, ?)",
                      [interaction.user.id, ctf.id, Date.now()]
                    );
                    db.run("DELETE FROM otp_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id]);

                    try {
                        const role = await getOrCreateCtfRole(interaction.guild, ctf.name, ctf.role_id);
                        const member = await interaction.guild.members.fetch(interaction.user.id);
                        await member.roles.add(role);

                        const { roomChannel, flagsChannel } = await ensureCtfChannels(interaction.guild, role, ctf.name, ctf);
                        db.run(
                          "UPDATE ctfs SET room_channel_id=?, flags_channel_id=?, role_id=? WHERE id=?",
                          [roomChannel?.id || null, flagsChannel?.id || null, role?.id || null, ctf.id]
                        );

                        interaction.editReply({ content: `Verification successful. You joined **${ctf.name}**.\nRoom: <#${roomChannel.id}>` });
                    } catch (e) {
                        console.error(e);
                        interaction.editReply({ content: "Joined database, but failed to assign role or channels. Check bot permissions." });
                    }
                });
            }
          );
      });
  }

  /* ------------------ USER: SUBMIT FLAG ------------------ */
  if (commandName === "flag") {
      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "❌ CTF name is required. Update commands and run /flag name:CTF_NAME ...", ephemeral: true });
      }
      getCtfByName(ctfName, (err, ctf) => {
          if (!ctf) return interaction.reply({ content: "CTF not found.", ephemeral: true });
          if (ctf.status === 'ended' || Date.now() > ctf.end) {
              return interaction.reply({ content: "🚫 CTF has ended. Submissions closed.", ephemeral: true });
          }
          if (Date.now() < ctf.start) {
              return interaction.reply({ content: "⏳ CTF hasn't started yet.", ephemeral: true });
          }

          const rawInput = interaction.options.getString("submission");
          const parts = rawInput.match(/==([^=]+)==/g);

          if (!parts || parts.length !== 3) {
              return interaction.reply({ 
                  content: "⚠️ **Format Error!**\nUse strict format:\n`==Challenge== ==Category== ==Flag==`\n\nExample:\n`==Web 1== ==Web== ==CTF{123}==`", 
                  ephemeral: true 
              });
          }

          const challenge = parts[0].replace(/==/g, "").trim();
          const category = parts[1].replace(/==/g, "").trim();
          const flag = parts[2].replace(/==/g, "").trim();

          if (!ctf.room_channel_id) {
              return interaction.reply({ content: "Private room is not ready yet. Join and verify this CTF first.", ephemeral: true });
          }

          if (interaction.channelId !== ctf.room_channel_id) {
              return interaction.reply({
                  content: `Submit flags only inside <#${ctf.room_channel_id}> for **${ctf.name}**.`,
                  ephemeral: true
              });
          }

          // Check if joined
          db.get("SELECT * FROM joined_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id], (err, joined) => {
              if (!joined) {
                  return interaction.reply({ content: "❌ You must `/join_ctf` & verify first.", ephemeral: true });
              }

              // Check Duplicate
              db.get("SELECT * FROM flags_ctf WHERE flag=? AND ctf_event_id=?", [flag, ctf.id], (err, exists) => {
                  if (exists) return interaction.reply({ content: "❌ Flag already submitted (by someone).", ephemeral: true });

                                    const eventId = ctf.id;
                  db.run("INSERT INTO flags_ctf (user_id, challenge, category, flag, timestamp, ctf_event_id) VALUES (?, ?, ?, ?, ?, ?)",
                    [interaction.user.id, challenge, category, flag, Date.now(), eventId],
                    async (err) => {
                        if (err) return interaction.reply({ content: "❌ Database Error (Unique constraint?).", ephemeral: true });

                        // Log to current CTF flags channel
                        const fallbackNames = getCtfChannelNames(ctf.name || "ctf");
                        const logChannel = ctf.flags_channel_id
                          ? interaction.guild.channels.cache.get(ctf.flags_channel_id)
                          : interaction.guild.channels.cache.find(c => c.name === fallbackNames.flags);
                        if (logChannel) {
                            const embed = new EmbedBuilder()
                                .setTitle("🚩 New Flag Submitted")
                                .setColor(Colors.Green)
                                .addFields(
                                    { name: "Solver", value: `<@${interaction.user.id}>`, inline: true },
                                    { name: "Challenge", value: challenge, inline: true },
                                    { name: "Category", value: category, inline: true }
                                )
                                .setTimestamp();
                            logChannel.send({ embeds: [embed] });
                        }

                        interaction.reply({ content: `✅ Correct! Flag accepted for **${challenge}**.`, ephemeral: true });
                    });
              });
          });
      });
  }

  /* ------------------ USER: SCOREBOARD ------------------ */
  if (commandName === "scoreboard") {
      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "❌ CTF name is required. Update commands and run /scoreboard name:CTF_NAME", ephemeral: true });
      }
      getCtfByName(ctfName, (err, ctf) => {
          if (!ctf) return interaction.reply({ content: "CTF not found.", ephemeral: true });

          db.all(
              `SELECT user_id, COUNT(*) as score FROM flags_ctf WHERE ctf_event_id=? GROUP BY user_id ORDER BY score DESC LIMIT 15`,
              [ctf.id],
              (err, rows) => {
                  if (!rows || rows.length === 0) return interaction.reply("📉 No solves yet.");

                  let desc = "";
                  rows.forEach((r, i) => {
                      desc += `**${i+1}.** <@${r.user_id}> : \`${r.score}\` 🚩\n`;
                  });

                  const embed = new EmbedBuilder()
                      .setTitle("🏆 Live Scoreboard")
                      .setColor(Colors.Purple)
                      .setDescription(desc)
                      .setTimestamp();
                  
                  interaction.reply({ embeds: [embed] });
              });
      });
  }

  /* ------------------ USER: TIMELEFT ------------------ */
  if (commandName === "timeleft") {
      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "❌ CTF name is required. Update commands and run /timeleft name:CTF_NAME", ephemeral: true });
      }
      getCtfByName(ctfName, (err, ctf) => {
          if (!ctf) return interaction.reply("CTF not found.");

          const now = Date.now();
          let msg = "";

          if (ctf.status === 'ended') {
              msg = "🏁 CTF has officially ended.";
          } else if (now < ctf.start) {
              msg = `⏳ Starts <t:${Math.floor(ctf.start/1000)}:R>`;
          } else if (now > ctf.end) {
              msg = "🏁 Time is up! Waiting for Admin to finalize.";
          } else {
              msg = `🕒 Remaining: <t:${Math.floor(ctf.end/1000)}:R>`;
          }

          interaction.reply({ content: msg, ephemeral: true });
      });
  }

});

/* ================= LOGIN ================= */
client.login(process.env.TOKEN);
