require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
  PermissionFlagsBits, 
  EmbedBuilder, 
  Colors, 
  ChannelType,
  Events
} = require("discord.js");
const { MongoClient } = require("mongodb");
const crypto = require("crypto");

/* ================= CONFIGURATION ================= */
const ADMIN_ID = process.env.ADMIN_ID || "843351441664901121"; 
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "flagbot";
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
let mongoClient;
let collections;

function normalizeSql(sql) {
    return sql.replace(/\s+/g, " ").trim();
}

function invokeRunCallback(callback, err, context = {}) {
    if (typeof callback === "function") {
        queueMicrotask(() => callback.call(context, err || null));
    } else if (err) {
        console.error(err);
    }
}

function invokeDataCallback(callback, err, data) {
    if (typeof callback === "function") {
        queueMicrotask(() => callback(err || null, data));
    } else if (err) {
        console.error(err);
    }
}

function resolveArgs(params, callback) {
    if (typeof params === "function") {
        return { params: [], callback: params };
    }

    return { params: params || [], callback };
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDuplicateKeyError(error) {
    return Boolean(error && (error.code === 11000 || error.code === 11001));
}

function logDbError(context, error) {
    console.error(`[${context}]`, error);
}

async function getNextSequence(name) {
    const counterResult = await collections.counters.findOneAndUpdate(
        { _id: name },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after" }
    );
    const counterDoc = counterResult?.value || counterResult;
    return counterDoc.seq;
}

function createDbAdapter() {
    return {
        serialize(callback) {
            if (typeof callback === "function") {
                callback();
            }
        },

        run(sql, params, callback) {
            const args = resolveArgs(params, callback);
            const normalized = normalizeSql(sql);

            (async () => {
                const context = {};

                if (
                    normalized.startsWith("CREATE TABLE IF NOT EXISTS") ||
                    normalized.startsWith("ALTER TABLE ctfs ADD COLUMN")
                ) {
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized.startsWith("INSERT INTO ctfs ")) {
                    const [name, url, format, start, end] = args.params;
                    const id = await getNextSequence("ctfs");
                    await collections.ctfs.insertOne({
                        id,
                        name,
                        url,
                        format,
                        start,
                        end,
                        status: "scheduled",
                        room_channel_id: null,
                        flags_channel_id: null,
                        role_id: null
                    });
                    context.lastID = id;
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "INSERT OR REPLACE INTO joined_ctf (user_id, ctf_id, joined_at) VALUES (?, ?, ?)") {
                    const [userId, ctfId, joinedAt] = args.params;
                    await collections.joined_ctf.updateOne(
                        { user_id: userId, ctf_id: ctfId },
                        { $set: { user_id: userId, ctf_id: ctfId, joined_at: joinedAt } },
                        { upsert: true }
                    );
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "DELETE FROM otp_ctf WHERE user_id=? AND ctf_id=?") {
                    const [userId, ctfId] = args.params;
                    await collections.otp_ctf.deleteMany({ user_id: userId, ctf_id: ctfId });
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "UPDATE ctfs SET room_channel_id=?, flags_channel_id=?, role_id=? WHERE id=?") {
                    const [roomChannelId, flagsChannelId, roleId, id] = args.params;
                    await collections.ctfs.updateOne(
                        { id },
                        { $set: { room_channel_id: roomChannelId, flags_channel_id: flagsChannelId, role_id: roleId } }
                    );
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "UPDATE ctfs SET status='ended' WHERE id=?") {
                    const [id] = args.params;
                    await collections.ctfs.updateOne({ id }, { $set: { status: "ended" } });
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "UPDATE ctfs SET flags_channel_id=? WHERE id=?") {
                    const [flagsChannelId, id] = args.params;
                    await collections.ctfs.updateOne({ id }, { $set: { flags_channel_id: flagsChannelId } });
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "DELETE FROM otp_ctf WHERE ctf_id=?") {
                    const [ctfId] = args.params;
                    await collections.otp_ctf.deleteMany({ ctf_id: ctfId });
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "DELETE FROM joined_ctf WHERE ctf_id=?") {
                    const [ctfId] = args.params;
                    await collections.joined_ctf.deleteMany({ ctf_id: ctfId });
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "DELETE FROM flags_ctf WHERE ctf_event_id=?") {
                    const [ctfId] = args.params;
                    await collections.flags_ctf.deleteMany({ ctf_event_id: ctfId });
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "DELETE FROM ctfs WHERE id=?") {
                    const [id] = args.params;
                    await collections.ctfs.deleteOne({ id });
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "UPDATE ctfs SET url=?, format=?, start=?, end=? WHERE id=?") {
                    const [url, format, start, end, id] = args.params;
                    await collections.ctfs.updateOne(
                        { id },
                        { $set: { url, format, start, end } }
                    );
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "INSERT OR REPLACE INTO otp_ctf (user_id, ctf_id, code, expires_at) VALUES (?, ?, ?, ?)") {
                    const [userId, ctfId, code, expiresAt] = args.params;
                    await collections.otp_ctf.updateOne(
                        { user_id: userId, ctf_id: ctfId },
                        { $set: { user_id: userId, ctf_id: ctfId, code, expires_at: expiresAt } },
                        { upsert: true }
                    );
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "DELETE FROM joined_ctf WHERE user_id=? AND ctf_id=?") {
                    const [userId, ctfId] = args.params;
                    await collections.joined_ctf.deleteOne({ user_id: userId, ctf_id: ctfId });
                    return invokeRunCallback(args.callback, null, context);
                }

                if (normalized === "INSERT INTO flags_ctf (user_id, challenge, category, flag, timestamp, ctf_event_id) VALUES (?, ?, ?, ?, ?, ?)") {
                    const [userId, challenge, category, flag, timestamp, ctfEventId] = args.params;
                    const id = await getNextSequence("flags_ctf");
                    await collections.flags_ctf.insertOne({
                        id,
                        user_id: userId,
                        challenge,
                        category,
                        flag,
                        timestamp,
                        ctf_event_id: ctfEventId
                    });
                    context.lastID = id;
                    return invokeRunCallback(args.callback, null, context);
                }

                throw new Error(`Unsupported db.run SQL: ${normalized}`);
            })().catch((error) => invokeRunCallback(args.callback, error));
        },

        get(sql, params, callback) {
            const args = resolveArgs(params, callback);
            const normalized = normalizeSql(sql);

            (async () => {
                if (normalized === "SELECT * FROM ctfs WHERE lower(name)=lower(?) ORDER BY id DESC LIMIT 1") {
                    const [name] = args.params;
                    const row = await collections.ctfs.find({
                        name: { $regex: `^${escapeRegExp(name)}$`, $options: "i" }
                    }).sort({ id: -1 }).limit(1).next();
                    return invokeDataCallback(args.callback, null, row || undefined);
                }

                if (normalized === "SELECT * FROM ctfs WHERE id=?") {
                    const [id] = args.params;
                    const row = await collections.ctfs.findOne({ id });
                    return invokeDataCallback(args.callback, null, row || undefined);
                }

                if (normalized === "SELECT * FROM ctfs WHERE room_channel_id=? OR flags_channel_id=? ORDER BY id DESC LIMIT 1") {
                    const [roomChannelId, flagsChannelId] = args.params;
                    const row = await collections.ctfs.find({
                        $or: [
                            { room_channel_id: roomChannelId },
                            { flags_channel_id: flagsChannelId }
                        ]
                    }).sort({ id: -1 }).limit(1).next();
                    return invokeDataCallback(args.callback, null, row || undefined);
                }

                if (normalized === "SELECT * FROM joined_ctf WHERE user_id=? AND ctf_id=?") {
                    const [userId, ctfId] = args.params;
                    const row = await collections.joined_ctf.findOne({ user_id: userId, ctf_id: ctfId });
                    return invokeDataCallback(args.callback, null, row || undefined);
                }

                if (normalized === "SELECT COUNT(DISTINCT user_id) as count FROM flags_ctf WHERE ctf_event_id=?") {
                    const [ctfId] = args.params;
                    const users = await collections.flags_ctf.distinct("user_id", { ctf_event_id: ctfId });
                    return invokeDataCallback(args.callback, null, { count: users.length });
                }

                if (normalized === "SELECT COUNT(*) as count FROM flags_ctf WHERE ctf_event_id=?") {
                    const [ctfId] = args.params;
                    const count = await collections.flags_ctf.countDocuments({ ctf_event_id: ctfId });
                    return invokeDataCallback(args.callback, null, { count });
                }

                if (normalized === "SELECT * FROM otp_ctf WHERE user_id=? AND ctf_id=? AND code=?") {
                    const [userId, ctfId, code] = args.params;
                    const row = await collections.otp_ctf.findOne({ user_id: userId, ctf_id: ctfId, code });
                    return invokeDataCallback(args.callback, null, row || undefined);
                }

                if (normalized === "SELECT * FROM otp_ctf WHERE user_id=? AND code=? ORDER BY expires_at DESC LIMIT 1") {
                    const [userId, code] = args.params;
                    const row = await collections.otp_ctf.find({ user_id: userId, code }).sort({ expires_at: -1 }).limit(1).next();
                    return invokeDataCallback(args.callback, null, row || undefined);
                }

                if (normalized === "SELECT * FROM flags_ctf WHERE flag=? AND ctf_event_id=?") {
                    const [flag, ctfId] = args.params;
                    const row = await collections.flags_ctf.findOne({ flag, ctf_event_id: ctfId });
                    return invokeDataCallback(args.callback, null, row || undefined);
                }

                throw new Error(`Unsupported db.get SQL: ${normalized}`);
            })().catch((error) => invokeDataCallback(args.callback, error));
        },

        all(sql, params, callback) {
            const args = resolveArgs(params, callback);
            const normalized = normalizeSql(sql);

            (async () => {
                if (normalized === "SELECT * FROM flags_ctf WHERE ctf_event_id=? ORDER BY timestamp ASC") {
                    const [ctfId] = args.params;
                    const rows = await collections.flags_ctf.find({ ctf_event_id: ctfId }).sort({ timestamp: 1 }).toArray();
                    return invokeDataCallback(args.callback, null, rows);
                }

                if (normalized === "SELECT user_id, COUNT(*) as score FROM flags_ctf WHERE ctf_event_id=? GROUP BY user_id ORDER BY score DESC, MIN(timestamp) ASC LIMIT 10") {
                    const [ctfId] = args.params;
                    const rows = await collections.flags_ctf.aggregate([
                        { $match: { ctf_event_id: ctfId } },
                        {
                            $group: {
                                _id: "$user_id",
                                score: { $sum: 1 },
                                firstSolve: { $min: "$timestamp" }
                            }
                        },
                        { $sort: { score: -1, firstSolve: 1 } },
                        { $limit: 10 },
                        { $project: { _id: 0, user_id: "$_id", score: 1 } }
                    ]).toArray();
                    return invokeDataCallback(args.callback, null, rows);
                }

                if (normalized === "SELECT * FROM ctfs WHERE status != 'ended' AND end <= ?") {
                    const [now] = args.params;
                    const rows = await collections.ctfs.find({
                        status: { $ne: "ended" },
                        end: { $lte: now }
                    }).sort({ end: 1 }).toArray();
                    return invokeDataCallback(args.callback, null, rows);
                }

                if (normalized === "SELECT * FROM flags_ctf WHERE ctf_event_id=? ORDER BY timestamp DESC") {
                    const [ctfId] = args.params;
                    const rows = await collections.flags_ctf.find({ ctf_event_id: ctfId }).sort({ timestamp: -1 }).toArray();
                    return invokeDataCallback(args.callback, null, rows);
                }

                if (normalized === "SELECT * FROM ctfs WHERE status != 'ended' ORDER BY start ASC") {
                    const rows = await collections.ctfs.find({ status: { $ne: "ended" } }).sort({ start: 1 }).toArray();
                    return invokeDataCallback(args.callback, null, rows);
                }

                if (normalized === "SELECT user_id, COUNT(*) as score FROM flags_ctf WHERE ctf_event_id=? GROUP BY user_id ORDER BY score DESC LIMIT 15") {
                    const [ctfId] = args.params;
                    const rows = await collections.flags_ctf.aggregate([
                        { $match: { ctf_event_id: ctfId } },
                        {
                            $group: {
                                _id: "$user_id",
                                score: { $sum: 1 },
                                firstSolve: { $min: "$timestamp" }
                            }
                        },
                        { $sort: { score: -1, firstSolve: 1 } },
                        { $limit: 15 },
                        { $project: { _id: 0, user_id: "$_id", score: 1 } }
                    ]).toArray();
                    return invokeDataCallback(args.callback, null, rows);
                }

                throw new Error(`Unsupported db.all SQL: ${normalized}`);
            })().catch((error) => invokeDataCallback(args.callback, error));
        }
    };
}

async function initDB() {
    if (!MONGODB_URI) {
        throw new Error("Missing MONGODB_URI in environment variables.");
    }

    mongoClient = new MongoClient(MONGODB_URI, {
        family: 4,
        serverSelectionTimeoutMS: 10000
    });
    await mongoClient.connect();

    const database = mongoClient.db(MONGODB_DB_NAME);
    collections = {
        ctfs: database.collection("ctfs"),
        joined_ctf: database.collection("joined_ctf"),
        flags_ctf: database.collection("flags_ctf"),
        otp_ctf: database.collection("otp_ctf"),
        counters: database.collection("counters")
    };

    await Promise.all([
        collections.ctfs.createIndex({ id: 1 }, { unique: true }),
        collections.ctfs.createIndex({ status: 1, end: 1 }),
        collections.ctfs.createIndex({ room_channel_id: 1 }),
        collections.ctfs.createIndex({ flags_channel_id: 1 }),
        collections.joined_ctf.createIndex({ user_id: 1, ctf_id: 1 }, { unique: true }),
        collections.flags_ctf.createIndex({ flag: 1, ctf_event_id: 1 }, { unique: true }),
        collections.flags_ctf.createIndex({ ctf_event_id: 1, timestamp: 1 }),
        collections.otp_ctf.createIndex({ user_id: 1, ctf_id: 1 }, { unique: true }),
        collections.otp_ctf.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })
    ]);
}

const db = createDbAdapter();

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

async function ensureCtfRoomChannel(guild, role, ctfName, storedIds) {
  const channelExists = (name) => guild.channels.cache.find(c => c.name === name);
  const channelById = (id) => (id ? guild.channels.cache.get(id) : null);

  const names = getCtfChannelNames(ctfName);

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

  const readOnlyChannels = [CHANNELS.ANNOUNCEMENTS];
  for (const name of readOnlyChannels) {
        const ch = guild.channels.cache.find(c => c.name === name);
        if (ch) {
            await ch.permissionOverwrites.edit(role.id, { 
                SendMessages: false,
                CreatePublicThreads: false,
                CreatePrivateThreads: false,
                AddReactions: true
            });
        }
  }

  return roomChannel;
}

async function ensureCtfFlagsChannel(guild, role, ctfName, storedIds) {
  const channelExists = (name) => guild.channels.cache.find(c => c.name === name);
  const channelById = (id) => (id ? guild.channels.cache.get(id) : null);
  const names = getCtfChannelNames(ctfName);

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

  return flagsChannel;
}

async function postAllFlagsToChannel(dbAll, flagsChannel, ctfId) {
    const rows = await dbAll(
        "SELECT * FROM flags_ctf WHERE ctf_event_id=? ORDER BY timestamp ASC",
        [ctfId]
    );

    if (!rows || rows.length === 0) {
        await flagsChannel.send("No flags were submitted for this CTF.");
        return;
    }

    let message = "**🚩 Final Submitted Flags**\n\n";
    for (const [index, row] of rows.entries()) {
        const line = `${index + 1}. <@${row.user_id}> | **${row.challenge}** (${row.category}) | \`${row.flag}\`\n`;
        if (message.length + line.length > 1900) {
            await flagsChannel.send(message);
            message = "";
        }
        message += line;
    }

    if (message.trim()) {
        await flagsChannel.send(message);
    }
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

function getCtfById(id, callback) {
    db.get(
        "SELECT * FROM ctfs WHERE id=?",
        [id],
        callback
    );
}

function getCtfByChannelId(channelId, callback) {
    db.get(
        "SELECT * FROM ctfs WHERE room_channel_id=? OR flags_channel_id=? ORDER BY id DESC LIMIT 1",
        [channelId, channelId],
        callback
    );
}

function resolveCtfForInteraction(interaction, providedName, callback) {
    if (providedName) {
        return getCtfByName(providedName, callback);
    }

    return getCtfByChannelId(interaction.channelId, callback);
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

async function completeCtfJoin(interaction, ctf) {
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

            const roomChannel = await ensureCtfRoomChannel(interaction.guild, role, ctf.name, ctf);
            db.run(
              "UPDATE ctfs SET room_channel_id=?, flags_channel_id=?, role_id=? WHERE id=?",
              [roomChannel?.id || null, ctf.flags_channel_id || null, role?.id || null, ctf.id]
            );

            interaction.editReply({ content: `Verification successful. You joined **${ctf.name}**.\nRoom: <#${roomChannel.id}>` });
        } catch (e) {
            console.error(e);
            interaction.editReply({ content: "Joined database, but failed to assign role or channels. Check bot permissions." });
        }
    });
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

    if (ctf.role_id) {
        const role = guild.roles.cache.get(ctf.role_id);
        if (role) {
            const flagsChannel = await ensureCtfFlagsChannel(guild, role, ctf.name, ctf);
            await new Promise((resolve, reject) => {
                db.run("UPDATE ctfs SET flags_channel_id=? WHERE id=?", [flagsChannel.id, ctf.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            await postAllFlagsToChannel(all, flagsChannel, ctf.id);
        }
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

    const existingCtf = await new Promise((resolve) => {
        getCtfByName(name, (lookupErr, row) => {
            if (lookupErr) {
                logDbError("create_ctf.lookup", lookupErr);
            }
            resolve(row || null);
        });
    });

    if (existingCtf && existingCtf.status !== "ended") {
        return interaction.editReply({ content: `A CTF named **${name}** already exists and is not ended yet.` });
    }

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
        if (err) {
            logDbError("join_ctf.lookup", err);
            return interaction.reply({ content: "Failed to load this CTF.", ephemeral: true });
        }

        if (!ctf || ctf.status === 'ended') {
             return interaction.reply({ content: "🚫 CTF not found or already ended.", ephemeral: true });
        }

        db.get("SELECT * FROM joined_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id], (err, row) => {
            if (err) {
                logDbError("join_ctf.joined_lookup", err);
                return interaction.reply({ content: "Failed to check your registration status.", ephemeral: true });
            }

            if (row) {
                return interaction.reply({ content: "✅ You have already joined!", ephemeral: true });
            }

            const otp = generateOTP();
            const expires = Date.now() + 5 * 60 * 1000; // 5 mins

            db.run(
              "INSERT OR REPLACE INTO otp_ctf (user_id, ctf_id, code, expires_at) VALUES (?, ?, ?, ?)",
              [interaction.user.id, ctf.id, otp, expires],
              (err) => {
                  if (err) {
                      logDbError("join_ctf.otp_upsert", err);
                      return interaction.reply({ content: "Failed to create your OTP. Please try again.", ephemeral: true });
                  }
                  
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
                logDbError("create_ctf.insert", err);
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

      if (ctfName) {
          return getCtfByName(ctfName, (err, ctf) => {
              if (err) {
                  logDbError("verify_otp.lookup_by_name", err);
                  return interaction.editReply({ content: "Failed to load this CTF." });
              }

              if (!ctf || ctf.status === "ended") {
                  return interaction.editReply({ content: "CTF not found or already ended." });
              }

              db.get(
                "SELECT * FROM otp_ctf WHERE user_id=? AND ctf_id=? AND code=?",
                [interaction.user.id, ctf.id, code.trim()],
                (err, otpRow) => {
                    if (err) {
                        logDbError("verify_otp.lookup_exact", err);
                        return interaction.editReply({ content: "Failed to verify this OTP." });
                    }

                    if (!otpRow) {
                        return interaction.editReply({ content: "Invalid OTP for this CTF. Run `/join_ctf` again." });
                    }

                    if (Date.now() > otpRow.expires_at) {
                        db.run("DELETE FROM otp_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, otpRow.ctf_id]);
                        return interaction.editReply({ content: "OTP expired. Run `/join_ctf` again." });
                    }

                    return completeCtfJoin(interaction, ctf);
                }
              );
          });
      }

      db.get(
        "SELECT * FROM otp_ctf WHERE user_id=? AND code=? ORDER BY expires_at DESC LIMIT 1",
        [interaction.user.id, code.trim()],
        (err, otpRow) => {
            if (err) {
                logDbError("verify_otp.lookup_latest", err);
                return interaction.editReply({ content: "Failed to verify this OTP." });
            }

            if (!otpRow) {
                return interaction.editReply({ content: "No OTP found for this code. Run `/join_ctf` again." });
            }

            if (Date.now() > otpRow.expires_at) {
                db.run("DELETE FROM otp_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, otpRow.ctf_id]);
                return interaction.editReply({ content: "OTP expired. Run `/join_ctf` again." });
            }

            return getCtfById(otpRow.ctf_id, (ctfErr, ctf) => {
                if (ctfErr) {
                    logDbError("verify_otp.lookup_by_id", ctfErr);
                    return interaction.editReply({ content: "Failed to load this CTF." });
                }

                if (!ctf || ctf.status === "ended") {
                    return interaction.editReply({ content: "CTF not found or already ended." });
                }

                return completeCtfJoin(interaction, ctf);
            });
        }
      );
  }

  /* ------------------ USER: SUBMIT FLAG ------------------ */
  if (commandName === "flag") {
      const ctfName = interaction.options.getString("name");
      resolveCtfForInteraction(interaction, ctfName, (err, ctf) => {
          if (err) {
              logDbError("flag.resolve_ctf", err);
              return interaction.reply({
                  content: "Failed to load this CTF. Please try again.",
                  ephemeral: true
              });
          }

          if (!ctf) {
              return interaction.reply({
                  content: "CTF not found. Use this command inside the CTF room or provide the CTF name.",
                  ephemeral: true
              });
          }
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
              if (err) {
                  logDbError("flag.joined_lookup", err);
                  return interaction.reply({ content: "Failed to verify your participation.", ephemeral: true });
              }

              if (!joined) {
                  return interaction.reply({ content: "❌ You must `/join_ctf` & verify first.", ephemeral: true });
              }

              // Check Duplicate
              db.get("SELECT * FROM flags_ctf WHERE flag=? AND ctf_event_id=?", [flag, ctf.id], (err, exists) => {
                  if (err) {
                      logDbError("flag.duplicate_lookup", err);
                      return interaction.reply({ content: "Failed to validate this submission.", ephemeral: true });
                  }

                  if (exists) return interaction.reply({ content: "❌ Flag already submitted (by someone).", ephemeral: true });

                                    const eventId = ctf.id;
                  db.run("INSERT INTO flags_ctf (user_id, challenge, category, flag, timestamp, ctf_event_id) VALUES (?, ?, ?, ?, ?, ?)",
                    [interaction.user.id, challenge, category, flag, Date.now(), eventId],
                    async (err) => {
                        if (err) {
                            if (isDuplicateKeyError(err)) {
                                return interaction.reply({ content: "❌ Flag already submitted (by someone).", ephemeral: true });
                            }

                            logDbError("flag.insert", err);
                            return interaction.reply({ content: "❌ Database Error while saving your flag.", ephemeral: true });
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
      resolveCtfForInteraction(interaction, ctfName, (err, ctf) => {
          if (err) {
              logDbError("scoreboard.resolve_ctf", err);
              return interaction.reply({
                  content: "Failed to load this CTF. Please try again.",
                  ephemeral: true
              });
          }

          if (!ctf) {
              return interaction.reply({
                  content: "CTF not found. Use this command inside the CTF room or provide the CTF name.",
                  ephemeral: true
              });
          }

          db.all(
              `SELECT user_id, COUNT(*) as score FROM flags_ctf WHERE ctf_event_id=? GROUP BY user_id ORDER BY score DESC LIMIT 15`,
              [ctf.id],
              (err, rows) => {
                  if (err) {
                      logDbError("scoreboard.list", err);
                      return interaction.reply({ content: "Failed to load the scoreboard.", ephemeral: true });
                  }

                  if (!rows || rows.length === 0) return interaction.reply({ content: "📉 No solves yet.", ephemeral: true });

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
      resolveCtfForInteraction(interaction, ctfName, (err, ctf) => {
          if (!ctf) {
              return interaction.reply({ content: "CTF not found. Use this command inside the CTF room or provide the CTF name.", ephemeral: true });
          }

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

  /* ------------------ USER: HELP ------------------ */
  if (commandName === "ctf_help") {
      const lines = [
          "**Admin Commands**",
          "`/create_ctf` : Create a new CTF event and announce it.",
          "`/edit_ctf` : Update CTF time, URL, or format and post an update.",
          "`/end_ctf` : End a CTF, publish results, and create the final flags channel.",
          "`/delete_ctf` : Delete a CTF and remove its saved bot data.",
          "`/allflags name:<ctf>` : View all submitted flags for that CTF.",
          "",
          "**User Commands**",
          "`/list_ctf` : Show all active and upcoming CTF events.",
          "`/join_ctf name:<ctf>` : Request an OTP for a selected CTF.",
          "`/verify_otp name:<ctf> code:<otp>` : Verify OTP and join the private room.",
          "`/flag submission:...` : Submit a flag inside the private CTF room. Name is optional inside the room.",
          "`/scoreboard` : Show the live scoreboard. Name is optional inside the CTF room.",
          "`/timeleft` : Show time remaining. Name is optional inside the CTF room.",
          "`/leave_ctf name:<ctf>` : Leave a CTF and remove room access.",
          "",
          "**How It Works**",
          "1. Admin creates a CTF with `/create_ctf`.",
          "2. Players view events with `/list_ctf` and join using `/join_ctf`.",
          "3. Players verify OTP with `/verify_otp` and get access to the private room.",
          "4. Players talk in the private room and submit flags there using `/flag`.",
          "5. When the CTF ends, the bot posts results and then creates the `_flags` channel with all submitted flags."
      ];

      return interaction.reply({ content: lines.join("\n"), ephemeral: true });
  }

});

/* ================= LOGIN ================= */
async function startBot() {
    try {
        await initDB();
        await client.login(process.env.TOKEN);
    } catch (error) {
        console.error("Failed to start bot:", error);
        console.error("Atlas connection tips: confirm the cluster is active, your current public IP is allowed in Atlas Network Access, and outbound access to port 27017 is not blocked.");
        process.exit(1);
    }
}

startBot();
