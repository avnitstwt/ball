'use strict';

(() => {
  const canvas = document.getElementById('stream-canvas');
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const panel = document.getElementById('development-panel');
  const diagnosticsGrid = document.getElementById('diagnostics-grid');
  const connectionState = document.getElementById('connection-state');
  const fullscreenButton = document.getElementById('fullscreen-button');
  const muteButton = document.getElementById('mute-button');
  const audioToggleBtn = document.getElementById('audio-toggle-btn');
  const captureMode = new URLSearchParams(window.location.search).get('capture') === '1';
  if (captureMode) document.body.classList.add('capture');

  const tiers = [
    { name: 'Mint Dot', radius: 24, color: '#62f0bc', accent: '#164e45', pattern: 'dot' },
    { name: 'Sky Pop', radius: 32, color: '#63c7ff', accent: '#16436a', pattern: 'ring' },
    { name: 'Grape Orb', radius: 42, color: '#a979ff', accent: '#4e287c', pattern: 'stars' },
    { name: 'Coral Bubble', radius: 54, color: '#ff7f76', accent: '#7d2e36', pattern: 'stripe' },
    { name: 'Golden Bounce', radius: 68, color: '#ffc64b', accent: '#75500d', pattern: 'sun' },
    { name: 'Lime Planet', radius: 84, color: '#a8e95f', accent: '#3d6620', pattern: 'leaf' },
    { name: 'Violet Giant', radius: 103, color: '#8c70ef', accent: '#39287b', pattern: 'diamond' },
    { name: 'Rainbow Core', radius: 126, color: '#f4f5ff', accent: '#5b4bd9', pattern: 'rainbow' }
  ];

  const photo = new Image();
  const qr = new Image();
  photo.decoding = 'async';
  qr.decoding = 'async';
  let assetsSettled = 0;
  let photoReady = false;
  let qrReady = false;
  let latestState = null;
  let latestDiagnostics = null;
  let websocket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let displayScore = 0;
  let previousRenderTime = performance.now();
  let localFrames = 0;
  let localFps = 0;
  let fpsWindowStarted = performance.now();
  let previewAudio = null;
  let muted = true;

  const settleAsset = () => {
    assetsSettled += 1;
    updateReadyFlag();
  };
  photo.addEventListener('load', () => { photoReady = true; settleAsset(); }, { once: true });
  photo.addEventListener('error', settleAsset, { once: true });
  qr.addEventListener('load', () => { qrReady = true; settleAsset(); }, { once: true });
  qr.addEventListener('error', settleAsset, { once: true });
  photo.src = '/assets/person-photo.jpg';
  qr.src = '/assets/payment-qr.jpg';

  function updateReadyFlag() {
    window.ballDropReady = assetsSettled >= 2 && latestState !== null;
  }

  function connect() {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    websocket = new WebSocket(`${scheme}//${window.location.host}/ws`);
    websocket.addEventListener('open', () => {
      reconnectAttempt = 0;
      if (connectionState) connectionState.textContent = 'Connected to local game';
      websocket.send(JSON.stringify({ type: 'hello', client: captureMode ? 'capture' : 'preview' }));
    });
    websocket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data.length > 2_000_000) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message && message.type === 'state') {
        latestState = message;
        if (canvas.width !== message.layout.width || canvas.height !== message.layout.height) {
          canvas.width = message.layout.width;
          canvas.height = message.layout.height;
        }
        panel.hidden = captureMode || !message.development;
        updateReadyFlag();
      } else if (message && message.type === 'diagnostics') {
        latestDiagnostics = message;
        updateDiagnostics();
      }
    });
    websocket.addEventListener('close', () => {
      if (connectionState) connectionState.textContent = 'Local connection lost; reconnecting…';
      scheduleReconnect();
    });
    websocket.addEventListener('error', () => websocket?.close());
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    const delay = Math.min(15_000, 500 * (2 ** reconnectAttempt));
    reconnectAttempt = Math.min(6, reconnectAttempt + 1);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function sendControl(action) {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
    websocket.send(JSON.stringify({ type: 'control', action }));
  }

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => sendControl(button.dataset.action));
  });
  fullscreenButton?.addEventListener('click', () => {
    document.querySelector('.preview-shell')?.requestFullscreen().catch(() => undefined);
  });
  function updateAudioButtonUI(isPlaying, customText) {
    const volPercent = (latestState && latestState.layout && typeof latestState.layout.musicVolume === 'number')
      ? Math.round(latestState.layout.musicVolume * 100)
      : 20;

    if (customText) {
      if (audioToggleBtn) audioToggleBtn.textContent = `⚠️ ${customText}`;
      if (muteButton) muteButton.textContent = customText;
      audioToggleBtn?.classList.remove('playing');
      return;
    }

    if (isPlaying) {
      if (audioToggleBtn) {
        audioToggleBtn.textContent = `🔊 Audio: Playing (${volPercent}%)`;
        audioToggleBtn.classList.add('playing');
      }
      if (muteButton) muteButton.textContent = 'Mute preview audio';
    } else {
      if (audioToggleBtn) {
        audioToggleBtn.textContent = '🔇 Audio: OFF (Click to Play)';
        audioToggleBtn.classList.remove('playing');
      }
      if (muteButton) muteButton.textContent = 'Unmute preview audio';
    }
  }

  function toggleAudio() {
    const targetVolume = (latestState && latestState.layout && typeof latestState.layout.musicVolume === 'number')
      ? latestState.layout.musicVolume
      : 0.20;

    if (!previewAudio) {
      previewAudio = new Audio('/assets/background-music.mp3');
      previewAudio.loop = true;
      previewAudio.preload = 'auto';
      previewAudio.addEventListener('error', (e) => {
        console.error('Audio load error:', e, previewAudio.error);
        updateAudioButtonUI(false, 'Audio file error');
      });
      previewAudio.addEventListener('playing', () => {
        muted = false;
        updateAudioButtonUI(true);
      });
      previewAudio.addEventListener('pause', () => {
        muted = true;
        updateAudioButtonUI(false);
      });
    }

    if (previewAudio.paused || previewAudio.muted || muted) {
      previewAudio.muted = false;
      previewAudio.volume = targetVolume;
      const playPromise = previewAudio.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          muted = false;
          updateAudioButtonUI(true);
        }).catch((err) => {
          console.warn('Audio play failed:', err);
          muted = true;
          updateAudioButtonUI(false, 'Click to allow audio');
        });
      }
    } else {
      previewAudio.pause();
      muted = true;
      updateAudioButtonUI(false);
    }
  }

  muteButton?.addEventListener('click', toggleAudio);
  audioToggleBtn?.addEventListener('click', toggleAudio);

  function roundedRect(ctx, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, safeRadius);
  }

  function drawImageFit(image, x, y, width, height, fit) {
    const sourceRatio = image.naturalWidth / image.naturalHeight;
    const targetRatio = width / height;
    let drawWidth;
    let drawHeight;
    let drawX;
    let drawY;
    if ((fit === 'cover' && sourceRatio > targetRatio) || (fit === 'contain' && sourceRatio < targetRatio)) {
      drawHeight = height;
      drawWidth = drawHeight * sourceRatio;
      drawX = x + (width - drawWidth) / 2;
      drawY = y;
    } else {
      drawWidth = width;
      drawHeight = drawWidth / sourceRatio;
      drawX = x;
      drawY = y + (height - drawHeight) / 2;
    }
    context.drawImage(image, Math.round(drawX), Math.round(drawY), Math.round(drawWidth), Math.round(drawHeight));
  }

  function drawBackground(state) {
    const width = state.layout.width;
    const height = state.layout.height;
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#0a1028');
    gradient.addColorStop(0.48, '#141a3c');
    gradient.addColorStop(1, '#090b17');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    context.globalAlpha = 0.14;
    context.strokeStyle = '#5c72c8';
    context.lineWidth = 1;
    for (let x = 0; x <= width; x += 60) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, state.layout.gameAreaHeight); context.stroke();
    }
    for (let y = 0; y <= state.layout.gameAreaHeight; y += 60) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
    }
    context.globalAlpha = 1;
  }

  function drawPhotoArea(state) {
    const y = state.layout.photoAreaY;
    const height = state.layout.height - y;
    context.save();
    context.beginPath();
    context.rect(0, y, state.layout.width, height);
    context.clip();
    if (photoReady) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      drawImageFit(photo, 0, y, state.layout.width, height, state.layout.personPhotoFit);
    } else {
      const fallback = context.createLinearGradient(0, y, 0, state.layout.height);
      fallback.addColorStop(0, '#252d57');
      fallback.addColorStop(1, '#0b0d1b');
      context.fillStyle = fallback;
      context.fillRect(0, y, state.layout.width, height);
    }
    const shade = context.createLinearGradient(0, y, 0, state.layout.height);
    shade.addColorStop(0, 'rgba(5,8,22,.18)');
    shade.addColorStop(0.58, 'rgba(5,8,22,.38)');
    shade.addColorStop(1, 'rgba(5,8,22,.88)');
    context.fillStyle = shade;
    context.fillRect(0, y, state.layout.width, height);
    context.restore();
  }

  function drawGamePanel(state) {
    const panelGradient = context.createLinearGradient(0, 70, 0, state.layout.gameAreaHeight);
    panelGradient.addColorStop(0, 'rgba(18,25,62,.82)');
    panelGradient.addColorStop(1, 'rgba(8,13,35,.62)');
    context.fillStyle = panelGradient;
    roundedRect(context, 24, 24, 706, state.layout.gameAreaHeight - 42, 34);
    context.fill();
    context.strokeStyle = 'rgba(150,169,255,.22)';
    context.lineWidth = 2;
    context.stroke();
  }

  function drawContainer() {
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.shadowColor = 'rgba(100,241,200,.38)';
    context.shadowBlur = 18;
    context.strokeStyle = '#6cf2c2';
    context.lineWidth = 13;
    context.beginPath();
    context.moveTo(46, 230);
    context.lineTo(76, 1062);
    context.quadraticCurveTo(385, 1092, 694, 1062);
    context.lineTo(724, 230);
    context.stroke();
    context.shadowBlur = 0;
    context.strokeStyle = 'rgba(255,255,255,.52)';
    context.lineWidth = 3;
    context.stroke();
    context.restore();
  }

  function drawBall(ball) {
    const tier = tiers[ball.tier] || tiers[0];
    const radius = tier.radius;
    context.save();
    context.translate(ball.x, ball.y);
    context.rotate(ball.angle);
    context.shadowColor = 'rgba(0,0,0,.35)';
    context.shadowBlur = Math.max(8, radius * 0.22);
    context.shadowOffsetY = Math.max(4, radius * 0.09);
    const fill = context.createRadialGradient(-radius * .32, -radius * .38, radius * .12, 0, 0, radius);
    fill.addColorStop(0, '#ffffff');
    fill.addColorStop(.12, tier.color);
    fill.addColorStop(1, tier.accent);
    context.fillStyle = fill;
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = 'rgba(255,255,255,.82)';
    context.lineWidth = Math.max(2, radius * .05);
    context.stroke();
    context.globalAlpha = .46;
    context.strokeStyle = tier.accent;
    context.fillStyle = tier.accent;
    context.lineWidth = Math.max(2, radius * .045);
    drawPattern(tier.pattern, radius);
    context.globalAlpha = 1;
    drawFace(radius, tier.accent);
    context.restore();
  }

  function drawPattern(pattern, radius) {
    if (pattern === 'dot') {
      context.beginPath(); context.arc(-radius * .34, -radius * .27, radius * .13, 0, Math.PI * 2); context.fill();
    } else if (pattern === 'ring') {
      context.beginPath(); context.arc(0, 0, radius * .62, 0, Math.PI * 2); context.stroke();
    } else if (pattern === 'stars') {
      for (let i = 0; i < 5; i += 1) { const a = i * 1.256; context.beginPath(); context.arc(Math.cos(a) * radius * .55, Math.sin(a) * radius * .55, radius * .07, 0, 7); context.fill(); }
    } else if (pattern === 'stripe') {
      context.beginPath(); context.moveTo(-radius * .75, radius * .3); context.quadraticCurveTo(0, -radius * .2, radius * .78, radius * .18); context.stroke();
    } else if (pattern === 'sun') {
      for (let i = 0; i < 10; i += 1) { const a = i * Math.PI / 5; context.beginPath(); context.moveTo(Math.cos(a) * radius * .52, Math.sin(a) * radius * .52); context.lineTo(Math.cos(a) * radius * .82, Math.sin(a) * radius * .82); context.stroke(); }
    } else if (pattern === 'leaf') {
      context.beginPath(); context.ellipse(0, -radius * .25, radius * .18, radius * .42, .65, 0, Math.PI * 2); context.stroke();
    } else if (pattern === 'diamond') {
      context.beginPath(); context.moveTo(0, -radius * .73); context.lineTo(radius * .55, 0); context.lineTo(0, radius * .73); context.lineTo(-radius * .55, 0); context.closePath(); context.stroke();
    } else if (pattern === 'rainbow') {
      const colors = ['#ff6f91','#ffcf5a','#73e88f','#67c8ff','#9d7cff'];
      colors.forEach((color, index) => { context.strokeStyle = color; context.lineWidth = Math.max(3, radius * .045); context.beginPath(); context.arc(0, 0, radius * (.35 + index * .09), Math.PI * 1.08, Math.PI * 1.92); context.stroke(); });
    }
  }

  function drawFace(radius, accent) {
    const eyeY = radius * .05;
    const eyeSpacing = radius * .27;
    context.fillStyle = 'rgba(255,255,255,.92)';
    for (const direction of [-1, 1]) { context.beginPath(); context.ellipse(direction * eyeSpacing, eyeY, radius * .12, radius * .16, 0, 0, Math.PI * 2); context.fill(); }
    context.fillStyle = accent;
    for (const direction of [-1, 1]) { context.beginPath(); context.arc(direction * eyeSpacing, eyeY + radius * .02, radius * .055, 0, Math.PI * 2); context.fill(); }
    context.strokeStyle = accent;
    context.lineWidth = Math.max(2, radius * .035);
    context.beginPath(); context.arc(0, radius * .17, radius * .22, .18, Math.PI - .18); context.stroke();
  }

  function drawParticles(state) {
    for (const particle of state.particles) {
      context.globalAlpha = particle.lifeRatio;
      context.fillStyle = particle.color;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size * (.55 + particle.lifeRatio * .45), 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    context.textAlign = 'center';
    context.font = '700 28px ui-rounded, system-ui, sans-serif';
    for (const label of state.labels) {
      context.globalAlpha = Math.min(1, label.lifeRatio * 1.7);
      context.fillStyle = label.color;
      context.shadowColor = 'rgba(0,0,0,.7)';
      context.shadowBlur = 7;
      context.fillText(label.text, label.x, label.y);
    }
    context.shadowBlur = 0;
    context.globalAlpha = 1;
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  }

  function drawHud(state) {
    context.save();
    context.fillStyle = 'rgba(7,10,27,.74)';
    roundedRect(context, 45, 48, 658, 148, 26);
    context.fill();
    context.fillStyle = '#ffffff';
    context.font = '800 50px ui-rounded, system-ui, sans-serif';
    context.textAlign = 'left';
    context.fillText(Math.round(displayScore).toLocaleString('en-US'), 72, 114);
    context.fillStyle = '#9aa7d8';
    context.font = '650 22px ui-rounded, system-ui, sans-serif';
    context.fillText('SCORE', 74, 151);
    context.fillStyle = '#e7eaff';
    context.font = '700 25px ui-rounded, system-ui, sans-serif';
    context.fillText(`BEST  ${state.bestScore.toLocaleString('en-US')}`, 272, 91);
    context.fillText(formatTime(state.elapsedSeconds), 272, 132);
    context.fillStyle = '#8df4cf';
    context.fillText(`LEVEL ${state.level} · ${state.stage}`, 272, 171);

    context.fillStyle = 'rgba(12,18,43,.85)';
    roundedRect(context, 568, 58, 112, 112, 24);
    context.fill();
    context.fillStyle = '#9aa7d8';
    context.textAlign = 'center';
    context.font = '650 17px ui-rounded, system-ui, sans-serif';
    context.fillText('NEXT', 624, 84);
    const tier = tiers[state.nextTier] || tiers[0];
    context.save();
    context.translate(624, 126);
    context.scale(.66, .66);
    drawBall({ x: 0, y: 0, angle: 0, tier: state.nextTier });
    context.restore();
    context.restore();
  }

  function drawGameOver(state) {
    if (!state.gameOver) return;
    context.save();
    context.fillStyle = 'rgba(6,8,24,.82)';
    roundedRect(context, 110, 365, 540, 330, 36);
    context.fill();
    context.strokeStyle = '#8df4cf';
    context.lineWidth = 3;
    context.stroke();
    context.textAlign = 'center';
    context.fillStyle = '#ffffff';
    context.font = '850 49px ui-rounded, system-ui, sans-serif';
    context.fillText(state.overlayText || 'SESSION COMPLETE', 380, 470);
    context.fillStyle = '#8df4cf';
    context.font = '750 36px ui-rounded, system-ui, sans-serif';
    context.fillText(`Score ${state.score.toLocaleString('en-US')}`, 380, 538);
    context.fillStyle = '#b8c0e8';
    context.font = '600 25px ui-rounded, system-ui, sans-serif';
    context.fillText(`Best ${state.bestScore.toLocaleString('en-US')}`, 380, 584);
    context.fillText('A new run starts automatically', 380, 635);
    context.restore();
  }

  function drawQr(state) {
    const x = Math.round(state.layout.qrX);
    const y = Math.round(state.layout.qrY);
    const width = Math.round(state.layout.qrWidth);
    const padding = Math.round(state.layout.qrPadding);
    const innerWidth = width - padding * 2;
    const imageRatio = qrReady ? qr.naturalHeight / qr.naturalWidth : 1;
    const imageHeight = Math.round(innerWidth * imageRatio);
    const labelHeight = 62;
    const panelHeight = padding + imageHeight + labelHeight + padding;
    context.save();
    context.shadowColor = 'rgba(0,0,0,.42)';
    context.shadowBlur = 26;
    context.fillStyle = '#ffffff';
    roundedRect(context, x, y, width, panelHeight, 22);
    context.fill();
    context.shadowBlur = 0;
    if (qrReady) {
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(qr, x + padding, y + padding, innerWidth, imageHeight);
    } else {
      context.fillStyle = '#eef0f5';
      context.fillRect(x + padding, y + padding, innerWidth, imageHeight);
      context.fillStyle = '#33394b';
      context.font = '650 18px system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillText('Local QR image unavailable', x + width / 2, y + padding + imageHeight / 2);
    }
    context.fillStyle = '#11172b';
    context.font = '800 24px ui-rounded, system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText(state.layout.qrLabel, x + width / 2, y + padding + imageHeight + 39);
    context.restore();
  }

  function drawLowerText(state) {
    // Overlay text removed as requested
  }

  function drawStatus(state) {
    context.save();
    const status = state.statusText || 'LIVE GAME';
    context.font = '750 19px ui-rounded, system-ui, sans-serif';
    const width = Math.max(166, context.measureText(status).width + 70);
    context.fillStyle = 'rgba(5,9,25,.80)';
    roundedRect(context, 50, state.layout.height - 172, width, 50, 25);
    context.fill();
    context.fillStyle = status.includes('Stability') ? '#ffd56c' : '#69f4bc';
    context.beginPath(); context.arc(75, state.layout.height - 147, 8, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#f7f8ff';
    context.textAlign = 'left';
    context.fillText(status, 96, state.layout.height - 140);
    context.restore();
  }

  function drawGuides(state) {
    if (!state.guides) return;
    context.save();
    context.strokeStyle = '#ffda66';
    context.lineWidth = 3;
    context.setLineDash([14, 10]);
    context.strokeRect(state.layout.qrX - 8, state.layout.qrY - 8, state.layout.qrWidth + 16, 470);
    context.strokeStyle = '#ff7b9f';
    context.beginPath(); context.moveTo(0, state.layout.gameAreaHeight); context.lineTo(state.layout.width, state.layout.gameAreaHeight); context.stroke();
    context.beginPath(); context.moveTo(0, state.layout.photoAreaY); context.lineTo(state.layout.width, state.layout.photoAreaY); context.stroke();
    context.setLineDash([]);
    context.fillStyle = '#fff';
    context.font = '700 18px system-ui, sans-serif';
    context.fillText('DEV QR SAFE AREA', state.layout.qrX, state.layout.qrY - 18);
    context.restore();
  }

  function render(now) {
    requestAnimationFrame(render);
    if (!latestState) {
      context.fillStyle = '#0a1028'; context.fillRect(0,0,canvas.width,canvas.height);
      context.fillStyle = '#e9ecff'; context.font = '700 34px system-ui, sans-serif'; context.textAlign = 'center';
      context.fillText('Preparing local game…', canvas.width / 2, canvas.height / 2);
      return;
    }
    const delta = Math.min(100, now - previousRenderTime);
    previousRenderTime = now;
    const difference = latestState.score - displayScore;
    displayScore += difference * Math.min(1, delta / 240);
    if (Math.abs(difference) < .5) displayScore = latestState.score;

    drawBackground(latestState);
    drawPhotoArea(latestState);
    drawGamePanel(latestState);
    drawContainer();
    latestState.balls.forEach(drawBall);
    drawParticles(latestState);
    drawHud(latestState);
    drawGameOver(latestState);
    drawQr(latestState);
    drawLowerText(latestState);
    drawStatus(latestState);
    drawGuides(latestState);

    localFrames += 1;
    const windowElapsed = now - fpsWindowStarted;
    if (windowElapsed >= 1_000) {
      localFps = localFrames * 1_000 / windowElapsed;
      localFrames = 0;
      fpsWindowStarted = now;
      updateDiagnostics();
    }
  }

  function updateDiagnostics() {
    if (!diagnosticsGrid || !latestDiagnostics || !latestState) return;
    const rows = [
      ['Current / avg FPS', `${localFps.toFixed(1)} / ${latestDiagnostics.averageFps.toFixed(1)}`],
      ['Physics updates/s', latestDiagnostics.physicsUpdatesPerSecond.toFixed(1)],
      ['Active balls / particles', `${latestState.balls.length} / ${latestState.particles.length}`],
      ['Score / best', `${latestState.score} / ${latestState.bestScore}`],
      ['Session duration', formatTime(latestState.elapsedSeconds)],
      ['Merges / recoveries', `${latestState.totalMerges} / ${latestState.recoveries}`],
      ['Frame writes / dropped', `${latestDiagnostics.frameWrites} / ${latestDiagnostics.droppedFrames}`],
      ['FFmpeg', latestDiagnostics.ffmpegStatus],
      ['WebSocket connections', String(latestDiagnostics.wsConnections)],
      ['Memory RSS', `${latestDiagnostics.memoryMb.toFixed(1)} MB`],
      ['Event-loop delay', `${latestDiagnostics.eventLoopDelayMs.toFixed(2)} ms`]
    ];
    diagnosticsGrid.replaceChildren(...rows.flatMap(([term, value]) => {
      const dt = document.createElement('dt'); dt.textContent = term;
      const dd = document.createElement('dd'); dd.textContent = value;
      return [dt, dd];
    }));
  }

  window.ballDropReady = false;
  connect();
  requestAnimationFrame(render);
})();
