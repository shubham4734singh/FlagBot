# 🚩 FlagBot Documentation

**FlagBot** is a Discord bot designed to automate Capture The Flag (CTF) events. It handles registration, flag submission, scoreboard tracking, and event scheduling—all through Discord Slash Commands.

---

## 🛠️ Setup & Installation

### 1. Prerequisites
- **Node.js** (v16.9.0 or higher)
- **Discord Bot Token** (from [Discord Developer Portal](https://discord.com/developers/applications))
- **Bot Permissions**:
  - `Manage Roles` (to assign per-CTF roles)
  - `Manage Channels` (to create private CTF rooms)
  - `Send Messages`
  - `Use Slash Commands`

### 2. Configuration (`.env`)
Create a `.env` file in the root folder:
```ini
TOKEN=your_bot_token_here
CLIENT_ID=your_bot_application_id
ADMIN_ID=your_discord_user_id
```

### 3. Installation
```bash
npm install                # Install dependencies
node deploy-commands.js    # Register Slash Commands (Run once)
node index.js              # Start the bot
```

---

## 🔐 Admin Commands (You Only)

### `/create_ctf`
Creates a new CTF event, announces it, and opens registration.
- **name**: Name of the CTF (e.g., "CyberQuest 2026")
- **start_datetime**: Start time (e.g., `2026-02-09T10:00:00`)
- **end_datetime**: End time (e.g., `2026-02-11T10:00:00`)
- **official_url**: Link to the CTF website or team invite.
- **format**: Format type (e.g., Jeopardy)

**Example:**
`/create_ctf name:HackTheBox start_datetime:2026-03-01T09:00:00 end_datetime:2026-03-03T09:00:00`

### `/end_ctf`
Manually ends a specific CTF.
- **name**: The exact CTF name used in `/create_ctf`.
- Sets status to "ended".
- Prevents new flag submissions.
- Publishes the **Final Results** to `#ctf-announcements`.

### `/allflags`
(Hidden) Lists **all submitted flags** so far.
- Only visible to the Admin (Ephemeral).
- Shows: User | Challenge | Flag
- **name**: The exact CTF name used in `/create_ctf`.

---

## 👤 Player Workflow

### 1. Joining (`/join_ctf`)
Players must join to participate.
- **name**: The exact CTF name used in `/create_ctf`.
- Bot sends a **One-Time Password (OTP)** (visible only to them).
- Bot instructs them to verify.

### 2. Verifying (`/verify_otp`)
- **code**: The 6-digit code received from `/join_ctf`.
- **Success**:
  - User gets a per-CTF role.
  - User gains access to private channels for that CTF.

### 3. Submitting Flags (`/flag`)
- **name**: The exact CTF name used in `/create_ctf`.
- **submission**: Enter the full submission string.
- **Strict Format Required**:
  You must use the format: `==Challenge Name== ==Category== ==Flag==`
  
  **Example**:
  `/flag name:BITSCTF 2026 submission: ==Web 101== ==Web Security== ==CTF{my_secret_flag}==`

- **Rules**:
  - The format must be exact.
  - No duplicate flags (if someone else submitted it, it's rejected).
  - Flags are logged to `#ctf-flags`.

### 4. Stats (`/scoreboard`, `/timeleft`)
- **`/scoreboard`**: Shows the Top 15 players (requires **name**).
- **`/timeleft`**: Shows time remaining until CTF ends (requires **name**).

---

## 📂 Channel Structure (Auto-Created)

| Channel | Visibility | Purpose |
| :--- | :--- | :--- |
| **#ctf-announcements** | Public | Bot posts CTF announcements and final results here. |
| **#ctf-<ctf-name>** | **Private** | Chat room for verified players of that CTF only. |
| **#ctf-<ctf-name>-flags** | **Private** | Read-only log of who solved what challenge for that CTF. |

**Notes**:
- No channels are created when you run `/create_ctf`.
- Channels are created only after a player verifies with `/verify_otp` for that CTF.
- If `#ctf-announcements` does not exist, the bot announces in the channel where `/create_ctf` was used.

---

## ✅ Multi-CTF Flow (A and B at the same time)

**Admin**
1. `/create_ctf name:CTF A start_datetime:2026-02-20T11:00:00 end_datetime:2026-02-22T11:00:00 official_url:https://example.com format:Jeopardy`
2. `/create_ctf name:CTF B start_datetime:2026-02-25T11:00:00 end_datetime:2026-02-26T11:00:00 official_url:https://example.com format:Jeopardy`

**Player**
1. `/join_ctf name:CTF A`
2. `/verify_otp code:123456`
3. `/join_ctf name:CTF B`
4. `/verify_otp code:654321`

Each CTF has its own private channels, flags, and scoreboard.

---

## ☁️ Deployment

### Hosting on Vercel?
**No.** Vercel is designed for websites and serverless functions (short-lived tasks). It **cannot host Discord bots** because bots need to stay online 24/7 listening for messages (Gateway Connection).

### Recommended Hosting Options (Free/Cheap)
1.  **Replit** (Quickest, might sleep if free)
2.  **Railway.app** (Great for Node.js + Databases)
3.  **Render.com** (Supports Background Workers)
4.  **Local / VPS** (Your PC or a Linux server like DigitalOcean)

### Hosting on Render (Example)
1. Push this code to **GitHub**.
2. Create a "Background Worker" (not Web Service) on Render.
3. Connect your GitHub Repo.
4. Set Build Command: `npm install`
5. Set Start Command: `node index.js`
6. Add Environment Variables (`TOKEN`, `ADMIN_ID`, etc.)

---

## ⚠️ Troubleshooting

**"Bot says I don't have permission"**
- Ensure your Discord User ID in `.env` matches your account.

**"Bot crashes on startup / SQL Error"**
- Delete the `ctf.db` file and restart to reset the database.

**"Application did not respond"**
- The bot is processing (e.g., verifying OTP). Wait a few seconds or try again. It now handles timeouts automatically.

**"DiscordAPIError: Missing Permissions"**
- **Fix:** Go to Server Settings > Roles. Drag the **FlagBot** role **ABOVE** the `CTF_PLAYER` role.
