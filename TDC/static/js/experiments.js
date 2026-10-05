(() => {
  'use strict';

  const section = document.querySelector('#real-world');
  if (!section) return;

  const tasks = {
    ww: { name: 'Whiteboard Wiping', cameras: ['Global Cam 1', 'Global Cam 2'], conditions: [
      ['undist', 'No Disturbance'], ['raise', 'Raised Whiteboard'],
      ['lower', 'Lowered Whiteboard'], ['tilt', 'Tilted Whiteboard']
    ] },
    ph: { name: 'Peg-in-Hole Insertion', cameras: ['Global Cam', 'Wrist Cam'], conditions: [
      ['undist', 'No Disturbance'], ['raise', 'Raised Board'], ['lower', 'Lowered Board']
    ] },
    mo: { name: 'Microwave Opening', cameras: ['Global Cam'], conditions: [
      ['undist', 'No Disturbance'], ['dist', 'With Disturbance']
    ] },
    do: { name: 'Door Opening', cameras: ['Global Cam'], conditions: [
      ['undist', 'No Disturbance'], ['dist', 'With Disturbance']
    ] }
  };
  const allVideos = [...section.querySelectorAll('.experiment-view video')];
  let videos = allVideos;
  const playButton = section.querySelector('.experiment-play');
  const restartButton = section.querySelector('.experiment-restart');
  const progress = section.querySelector('.experiment-progress');
  const timeLabel = section.querySelector('.experiment-time');
  const status = section.querySelector('.experiment-status');
  const conditions = section.querySelector('.experiment-conditions');
  let taskKey = 'ww';
  let conditionIndex = 0;
  let duration = 0;
  let ready = false;
  let wantedPlaying = false;
  let phase = 'loading';
  let operation;
  let animation;
  let lastSync = 0;
  let resumeAfterSeek = false;

  const formatTime = value => {
    const seconds = Math.max(0, Math.floor(value || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  function showTime(time) {
    progress.value = String(time);
    progress.setAttribute('aria-valuetext', `${formatTime(time)} of ${formatTime(duration)}`);
    timeLabel.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
  }
  function pauseVideos() {
    cancelAnimationFrame(animation);
    allVideos.forEach(video => video.pause());
  }
  function cancelOperation() {
    if (operation) operation.abort();
    pauseVideos();
  }
  function updateControls() {
    playButton.disabled = !ready && phase !== 'error';
    restartButton.disabled = !ready;
    progress.disabled = !ready;
    playButton.textContent = phase === 'error' ? 'Retry' : wantedPlaying ? 'Pause All' : phase === 'ended' ? 'Replay All' : 'Play All';
  }
  function fail() {
    cancelOperation();
    wantedPlaying = false;
    ready = false;
    phase = 'error';
    status.textContent = 'A video could not be loaded. Select Retry to reload this experiment.';
    updateControls();
  }
  function waitForMedia(video, predicate, signal) {
    return new Promise((resolve, reject) => {
      const events = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'seeked', 'progress', 'error'];
      const cleanup = () => {
        clearTimeout(timeout);
        events.forEach(event => video.removeEventListener(event, check));
        signal.removeEventListener('abort', abort);
      };
      const finish = error => { cleanup(); error ? reject(error) : resolve(); };
      const check = () => {
        if (video.error) finish(new Error('Video loading failed'));
        else if (predicate()) finish();
      };
      const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
      const timeout = setTimeout(() => finish(new Error('Video loading timed out')), 30000);
      events.forEach(event => video.addEventListener(event, check));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
  }

  // All sources share a timestamp. Wait for every active view before starting or resuming;
  // switching conditions cancels pending media operations from the previous group.
  async function synchronize(time, resume, loading = false) {
    cancelOperation();
    const current = new AbortController();
    operation = current;
    wantedPlaying = resume;
    phase = loading ? 'loading' : 'buffering';
    status.textContent = loading ? 'Loading experiment…' : 'Synchronizing videos…';
    updateControls();
    try {
      await Promise.all(videos.map(video => waitForMedia(video, () => video.readyState >= 1, current.signal)));
      if (current.signal.aborted) return;
      // Supplied recordings have matching durations. Use their common playable end
      // to handle minor container/decoder rounding differences without overruns.
      duration = Math.min(...videos.map(video => video.duration));
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid duration');
      progress.max = String(duration);
      const target = Math.max(0, Math.min(time, duration));
      videos.forEach(video => { video.currentTime = target; });
      await Promise.all(videos.map(video => waitForMedia(video, () => video.readyState >= 3 && !video.seeking, current.signal)));
      if (current.signal.aborted) return;
      ready = true;
      showTime(target);
      if (target >= duration) {
        finish();
        return;
      }
      if (resume) {
        // Calling play in the same turn minimizes initial skew; the master clock
        // below corrects drift and pauses the entire group if any view buffers.
        await Promise.all(videos.map(video => video.play()));
        if (current.signal.aborted) return;
        phase = 'playing';
        status.textContent = 'All views play together.';
        lastSync = 0;
        animation = requestAnimationFrame(tick);
      } else {
        phase = 'paused';
        status.textContent = 'One timeline for the camera views and force plot.';
      }
      updateControls();
    } catch (error) {
      if (current.signal.aborted) return;
      if (error.name === 'NotAllowedError') {
        pause();
        status.textContent = 'Select Play All to start all views.';
      } else fail();
    }
  }
  function pause() {
    cancelOperation();
    wantedPlaying = false;
    phase = 'paused';
    showTime(videos[0].currentTime);
    status.textContent = 'All views paused.';
    updateControls();
  }
  function finish() {
    cancelOperation();
    wantedPlaying = false;
    phase = 'ended';
    videos.forEach(video => { video.currentTime = duration; });
    showTime(duration);
    status.textContent = 'Experiment complete. Replay or select another condition.';
    updateControls();
  }
  function tick(now) {
    if (phase !== 'playing') return;
    const time = videos[0].currentTime;
    showTime(time);
    if (time >= duration || videos.some(video => video.ended)) {
      finish();
      return;
    }
    if (now - lastSync >= 100) {
      lastSync = now;
      // A frame-level correction is only needed when a decoder drifts. Rejoin
      // the shared timestamp as a group, so no view plays ahead during buffering.
      if (videos.some(video => video.readyState < 3 || Math.abs(video.currentTime - time) > 0.1)) {
        synchronize(time, true);
        return;
      }
    }
    animation = requestAnimationFrame(tick);
  }

  function selectExperiment(key, index) {
    cancelOperation();
    taskKey = key;
    conditionIndex = index;
    ready = false;
    duration = 0;
    resumeAfterSeek = false;
    const task = tasks[key];
    const [condition, label] = task.conditions[index];
    section.querySelectorAll('[data-task]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.task === key)));
    conditions.replaceChildren(...task.conditions.map(([, name], i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.dataset.condition = String(i);
      button.setAttribute('aria-pressed', String(i === index));
      return button;
    }));
    section.querySelector('.experiment-task-name').textContent = task.name;
    section.querySelector('#experiment-name').textContent = label;
    section.querySelector('.experiment-count').textContent = `${index + 1} / ${task.conditions.length}`;
    section.querySelector('#camera-one-label').textContent = task.cameras[0];
    const singleCamera = task.cameras.length === 1;
    section.querySelector('.experiment-cameras').classList.toggle('single-camera', singleCamera);
    allVideos[1].closest('figure').hidden = singleCamera;
    section.querySelector('#camera-two-label').textContent = task.cameras[1] || '';
    // Remove the unused source as well as the view: it must not download, play,
    // or participate in synchronization for the single-camera tasks.
    videos = singleCamera ? [allVideos[0], allVideos[2]] : allVideos;
    if (singleCamera) {
      allVideos[1].removeAttribute('src');
      allVideos[1].load();
    }
    const suffixes = singleCamera
      ? ['external_cam', 'force']
      : ['external_cam', key === 'ww' ? 'external_cam_2' : 'wrist_cam', 'force'];
    videos.forEach((video, i) => {
      video.preload = 'auto';
      video.src = `static/videos/exp_videos/${key}_${condition}_${suffixes[i]}.mp4`;
      video.load();
    });
    showTime(0);
    synchronize(0, false, true);
  }

  section.querySelectorAll('[data-task]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.task !== taskKey) selectExperiment(button.dataset.task, 0);
  }));
  conditions.addEventListener('click', event => {
    const button = event.target.closest('[data-condition]');
    if (!button || Number(button.dataset.condition) === conditionIndex) return;
    const index = Number(button.dataset.condition);
    selectExperiment(taskKey, index);
    // Keep keyboard focus on the replacement button after rebuilding the list.
    conditions.children[index].focus({ preventScroll: true });
  });
  section.querySelectorAll('[data-direction]').forEach(button => button.addEventListener('click', () => {
    const count = tasks[taskKey].conditions.length;
    selectExperiment(taskKey, (conditionIndex + Number(button.dataset.direction) + count) % count);
  }));
  playButton.addEventListener('click', () => {
    if (phase === 'error') selectExperiment(taskKey, conditionIndex);
    else if (wantedPlaying) pause();
    else synchronize(phase === 'ended' ? 0 : videos[0].currentTime, true);
  });
  restartButton.addEventListener('click', () => synchronize(0, true));
  progress.addEventListener('input', () => {
    resumeAfterSeek = resumeAfterSeek || wantedPlaying;
    const target = Number(progress.value);
    cancelOperation();
    wantedPlaying = false;
    phase = 'seeking';
    status.textContent = 'Seeking all views…';
    showTime(target);
    updateControls();
  });
  progress.addEventListener('change', () => {
    const resume = resumeAfterSeek;
    resumeAfterSeek = false;
    synchronize(Number(progress.value), resume);
  });
  allVideos.forEach(video => {
    video.addEventListener('waiting', () => {
      if (videos.includes(video) && phase === 'playing') synchronize(videos[0].currentTime, true);
    });
    video.addEventListener('ended', () => {
      if (videos.includes(video) && phase === 'playing') finish();
    });
    video.addEventListener('error', () => {
      if (videos.includes(video) && (phase === 'playing' || phase === 'paused')) fail();
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && wantedPlaying) pause();
  });
  window.addEventListener('pagehide', () => { cancelOperation(); });

  selectExperiment(taskKey, conditionIndex);
})();
