# Hum Dono 💕 — Private Couple Chat & WebRTC Suite

> **Sirf tum dono. Private chat, crystal-clear WebRTC video/voice calls, and zero tracking.**
> Includes the complete application, production-ready full-stack server, WebRTC signalling, Web Push notification pipeline, and built-in GitHub Repository Automation.

[![React](https://img.shields.io/badge/React-19-blue.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-v4-38bdf8.svg)](https://tailwindcss.com/)
[![WebRTC](https://img.shields.io/badge/WebRTC-Audio%2FVideo-orange.svg)](https://webrtc.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🌟 Key Highlights

- **🔒 Two-Person Exclusivity**: Enforces strict 2-member limit per room. Secure token authentication ensures privacy.
- **📹 Peer-to-Peer WebRTC Calling**: Low-latency HD video and voice calls with:
  - Picture-in-Picture draggable self-view camera
  - Instant front/back camera flipping (`user` ↔ `environment`)
  - Microphone mute / camera privacy controls
  - Floating live message feed over video during active calls
- **💬 Real-Time Messaging & Media**:
  - Live typing indicator (`typing… ✍️`) & active presence indicators (`online 💚` / last seen)
  - Message delivery & read receipts (Sent `✓`, Delivered `✓✓`, Read `✓✓` blue)
  - Direct camera / photo uploads with client-side canvas compression
  - Quick emoji tray
- **⏱️ Smart Privacy & Auto-Delete Modes**:
  - `Save`: Persistent memories
  - `Day (24h)`: Auto-purges older messages automatically
  - `Seen-Delete`: Self-destructs messages seconds after partner views them
- **🔔 Web Push Notifications**: Native RFC 8291 / RFC 8292 VAPID push payload encryption for background incoming calls and new messages.
- **🚀 Built-in GitHub Repo Pusher**: 1-click in-app repository creator that can initialize git, generate commits, call GitHub API, and push straight to your personal GitHub account!
- **⚡ Dual Engine**: Also includes the integrated *66Lottery Ultra Pattern Matrix Bot* with True Math (0.96x fee calculation), Martingale 3X money manager, B&S Master Chart pattern recognizer, and Gemini Neural Insight.

---

## 📁 Project Structure

```
├── server.ts              # Full-stack Express backend with WebRTC signalling & GitHub API
├── index.html             # HTML entry point with metadata & PWA tags
├── package.json           # Dependencies and build scripts
├── vite.config.ts         # Vite bundler configuration
├── src/
│   ├── App.tsx            # Main unified UI (Hum Dono Chat, Call Stage, GitHub Pusher, Pattern Bot)
│   ├── main.tsx           # React root
│   ├── index.css          # Tailwind CSS styles
│   └── hum-dono/          # Original standalone client & server assets
├── public/
│   ├── manifest.json      # Progressive Web App manifest
│   ├── sw.js              # Service Worker (offline shell & Web Push handler)
│   └── icons/             # App icons
└── README.md              # Project documentation
```

---

## 🚀 Getting Started

### 1. Prerequisites
- Node.js 18+ or 20+
- npm, pnpm, or bun
- Git installed on your system

### 2. Installation
```bash
git clone <YOUR_GITHUB_REPO_URL>
cd hum-dono
npm install
```

### 3. Running in Development
```bash
npm run dev
```
The server will start on `http://localhost:3000`.

### 4. Building for Production
```bash
npm run build
npm start
```

---

## 🐙 Pushing to GitHub Manually

If you prefer using the command line instead of the in-app 1-Click Pusher:

```bash
# Initialize git if not already done
git init
git branch -M main

# Add all files and make initial commit
git add .
git commit -m "Initial commit: Hum Dono private couple chat & video calling app"

# Link your GitHub repository
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.NAME.git

# Push to GitHub
git push -u origin main
```

---

## 🛡️ Security & Privacy Notice
- Signalling is done over lightweight HTTP polling/state exchange.
- Media streams (audio and video) flow direct peer-to-peer over WebRTC encrypted using DTLS-SRTP.
- No public chat directories or indexing. Rooms require the private 8-character verification code to join.

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
