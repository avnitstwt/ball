# Ball Drop Endless Live — Complete Guide & Commands

Yeh document project ke pure setup, diagnostics, testing, aur YouTube live stream ko headless (background) chalane ke sabhi commands aur configurations ki step-by-step guide hai.

---

## 1. Architecture Overview (Zero-UI Background Streaming)

Yeh project **bina kisi visible browser window ya screen-sharing software (OBS/Streamlabs)** ke chalta hai:

```
[Node.js Engine (authoritative)]  --> 60 Hz physics (Matter.js), scoring, combos
            │
            ▼ (Local WebSocket)
[Headless Chromium (RAM only)]     --> 1080×1920 Canvas render karta hai bina screen par window khole
            │
            ▼ (In-Memory Buffer Pipe)
[FFmpeg Encoder]                  --> Apple Silicon Hardware (`h264_videotoolbox`) se H.264 encode karta hai
            │
            ▼ (Encrypted RTMPS)
[YouTube Live Server]             --> 24/7 direct broadcast
```

- **CPU & RAM friendly**: Frames disk par write nahi hote; directly memory (RAM) se FFmpeg ko pipe hote hain.
- **Mac Hardware Acceleration**: Apple Silicon ka native hardware encoder (`h264_videotoolbox`) use hota hai.
- **Persistence**: SQLite database (`runtime/game.db`) me best scores aur session checkpoints save rehte hain.

---

## 2. Environment Configuration (`.env`)

Aapka configuration file [`.env`](file:///Users/niteesh/Downloads/ball-drop-endless-live/.env) project root par maujood hai.

### Important Settings:
| Parameter | Default Value | Description |
|---|---|---|
| `NODE_ENV` | `production` / `development` | `production` me dev controls disable rehte hain |
| `TEST_MODE` | `false` / `true` | `false` hone par stream YouTube par jaati hai; `true` par local MP4 banti hai |
| `YOUTUBE_RTMPS_URL` | `rtmps://a.rtmps.youtube.com/live2/<KEY>` | YouTube Stream URL + Secret Key |
| `STREAM_DURATION_SECONDS` | `0` | `0` matlab endless stream (jab tak manual stop na karein) |
| `FPS` | `30` | Canvas capture aur stream framerate |
| `WIDTH` x `HEIGHT` | `1080` x `1920` | Vertical 9:16 portrait resolution |
| `VIDEO_BITRATE` | `4500k` | YouTube 1080p recommendation (4500–6000k) |
| `ENABLE_AUDIO` | `false` | `true` karke `assets/background-music.mp3` add kar sakte hain |

---

## 3. Diagnostic Commands

Environment check karne ke liye ki FFmpeg, Chromium, Port, aur Assets theek hain ya nahi:

```bash
# Run diagnostics check
npm run diagnostics
```

**Expected Healthy Output:**
- `FFmpeg version`: Installed
- `h264_videotoolbox`: `AVAILABLE`
- `Person photo found`: `YES`
- `Payment QR found`: `YES`
- `Port available`: `YES (127.0.0.1:3000)`
- `Playwright Chromium`: `AVAILABLE`
- `YOUTUBE_RTMPS_URL configured`: `YES`

---

## 4. Layout Preview (Offline Snapshot)

Agar stream shuru kiye bina sirf canvas ka visual layout (balls area, QR code, bottom photo) check karna ho:

```bash
# Generates a PNG screenshot of the 1080x1920 layout
npm run preview:layout

# View the generated image on Mac
open runtime/layout-preview.png
```

---

## 5. Local Test Mode (Without Streaming to YouTube)

YouTube par live jane se pehle poora headless browser + FFmpeg pipeline test karne ke liye:

```bash
# Runs for 120 seconds, captures headless frames, and encodes an MP4 file
npm run test:local
```
- Is command me koi UI open nahi hoga.
- Background me Chromium aur FFmpeg chalenge.
- Output file [`runtime/test-output.mp4`](file:///Users/niteesh/Downloads/ball-drop-endless-live/runtime) me save hogi.
- Video ko play karke check kar sakte hain:
  ```bash
  open runtime/test-output.mp4
  ```

---

## 6. Live Preview Mode (Interactive UI Testing)

Agar browser me game physics aur developer controls manually test karne ho:

```bash
# Start preview server
npm run dev
```
Fir browser me open karein:
[http://localhost:3000](http://localhost:3000)

*Note: Yeh mode stream broadcast nahi karta, sirf visual manual testing ke liye hai.*

---

## 7. Starting the YouTube Livestream (Production)

### Method A: Foreground (Terminal open rakhna hoga)
```bash
# 1. TypeScript build verify karein
npm run build

# 2. Production stream start karein
npm run start:production
```

### Method B: Background / Detached Mode (Terminal band kar sakte hain)
Agar aap chahte hain ki process poori tarah background me chalti rahe:

```bash
# Start completely detached in background
nohup npm run start:production > runtime/stream.log 2>&1 &
```

**Live logs monitor karne ke liye:**
```bash
tail -f runtime/stream.log
# ya FFmpeg ki internal log:
tail -f runtime/ffmpeg.log
```

### Method C: PM2 Process Manager (Auto-restart capability)
Agar system restart ke baad bhi auto-manage rakhna ho:

```bash
# Install PM2 globally (agar pehle se nahi hai)
npm install -g pm2

# Start background process
pm2 start dist/index.js --name "youtube-stream" --env NODE_ENV=production

# Check status
pm2 status

# View logs
pm2 logs youtube-stream
```

---

## 8. Stopping the Livestream

### If started via Terminal foreground:
Terminal me `Ctrl + C` dabayein (graceful shutdown triggers, saves SQLite checkpoint).

### If started via `nohup` (Background):
```bash
# Port 3000 par chal rahe process ko search aur kill karein
lsof -ti :3000 | xargs kill -15
```

### If started via PM2:
```bash
pm2 stop youtube-stream
pm2 delete youtube-stream
```

### Force Kill (Emergency stop):
```bash
pkill -f "dist/index.js"
pkill -f "ffmpeg"
```

---

## 9. Troubleshooting & Tips

1. **Port already in use (`Port available: NO`)**:
   Purana node process port 3000 release nahi kiya to run karein:
   ```bash
   lsof -ti :3000 | xargs kill -9
   ```

2. **Stream Key update karna**:
   [`.env`](file:///Users/niteesh/Downloads/ball-drop-endless-live/.env) file me `YOUTUBE_RTMPS_URL` line update karein:
   ```env
   YOUTUBE_RTMPS_URL=rtmps://a.rtmps.youtube.com/live2/<NEW_KEY>
   ```

3. **Background Music lagana**:
   - Apni music file `assets/background-music.mp3` par place karein.
   - [`.env`](file:///Users/niteesh/Downloads/ball-drop-endless-live/.env) me `ENABLE_AUDIO=true` set karein.
