# 🚩 FlagBot Documentation

**FlagBot** is a Discord bot designed to automate Capture The Flag (CTF) events. It handles registration, flag submission, scoreboard tracking, and event scheduling—all through Discord Slash Commands.

---

## 🛠️ Setup & Installation

### 1. Prerequisites
- **Node.js** (v16.9.0 or higher)
- **Discord Bot Token** (from [Discord Developer Portal](https://discord.com/developers/applications))
- **Bot Permissions**:
  - `Manage Roles` (to assign CTF_PLAYER role)
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
Manually ends the current CTF.
- Sets status to "ended".
- Prevents new flag submissions.
- Publishes the **Final Results** to `#ctf-announcements`.

### `/allflags`
(Hidden) Lists **all submitted flags** so far.
- Only visible to the Admin (Ephemeral).
- Shows: User | Challenge | Flag

---

## 👤 Player Workflow

### 1. Joining (`/join_ctf`)
Players must join to participate.
- Bot sends a **One-Time Password (OTP)** (visible only to them).
- Bot instructs them to verify.

### 2. Verifying (`/verify_otp`)
- **code**: The 6-digit code received from `/join_ctf`.
- **Success**:
  - User gets `CTF_PLAYER` role.
  - User gains access to private channels: `#ctf-room` & `#ctf-flags`.

### 3. Submitting Flags (`/flag`)
- **submission**: Enter the full submission string.
- **Strict Format Required**:
  You must use the format: `==Challenge Name== ==Category== ==Flag==`
  
  **Example**:
  `/flag submission: ==Web 101== ==Web Security== ==CTF{my_secret_flag}==`

- **Rules**:
  - The format must be exact.
  - No duplicate flags (if someone else submitted it, it's rejected).
  - Flags are logged to `#ctf-flags`.

### 4. Stats (`/scoreboard`, `/timeleft`)
- **`/scoreboard`**: Shows the Top 15 players.
- **`/timeleft`**: Shows time remaining until CTF ends.

---

## 📂 Channel Structure (Auto-Created)

| Channel | Visibility | Purpose |
| :--- | :--- | :--- |
| **#ctf-announcements** | Public | Bot posts CTF announcements and final results here. |
| **#ctf-room** | **Private** | Chat room for verified players only. |
| **#ctf-flags** | **Private** | Read-only log of who solved what challenge. |

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
