(() => {
  const topicList = document.querySelector("#topicList");
  const homePanel = document.querySelector("#homePanel");
  const examPanel = document.querySelector("#examPanel");
  const summaryPanel = document.querySelector("#summaryPanel");
  const startBtn = document.querySelector("#startBtn");
  const showQuestionsToggle = document.querySelector("#showQuestionsToggle");
  const homeStatus = document.querySelector("#homeStatus");
  const examStatus = document.querySelector("#examStatus");
  const topicChips = document.querySelector("#topicChips");
  const qMeta = document.querySelector("#qMeta");
  const qTopic = document.querySelector("#qTopic");
  const qText = document.querySelector("#qText");
  const replayBtn = document.querySelector("#replayBtn");
  const recordBtn = document.querySelector("#recordBtn");
  const skipBtn = document.querySelector("#skipBtn");
  const stopExamBtn = document.querySelector("#stopExamBtn");
  const nextBtn = document.querySelector("#nextBtn");
  const answerBox = document.querySelector("#answerBox");
  const answerText = document.querySelector("#answerText");
  const feedbackBox = document.querySelector("#feedbackBox");
  const summaryList = document.querySelector("#summaryList");
  const againBtn = document.querySelector("#againBtn");
  const homeBtn = document.querySelector("#homeBtn");
  const progressCount = document.querySelector("#progressCount");
  const progressLabel = document.querySelector("#progressLabel");
  const progressFill = document.querySelector("#progressFill");
  const pageTitle = document.querySelector("#pageTitle");
  const topMeta = document.querySelector("#topMeta");
  const speechRate = document.querySelector("#speechRate");
  const speechRateExam = document.querySelector("#speechRateExam");
  const selectionSummary = document.querySelector("#selectionSummary");
  const clearTopicsBtn = document.querySelector("#clearTopicsBtn");
  const randomTwoBtn = document.querySelector("#randomTwoBtn");

  const rateStorageKey = "speaking-t1-speech-rate";
  const topicsStorageKey = "speaking-t1-selected-topics";

  let topicsCatalog = [];
  let selectedTopicIds = new Set();
  let showQuestionText = false;
  let session = null;
  let index = 0;
  let answers = [];
  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let busy = false;
  let currentAudio = null;
  let recordPointerId = null;
  let recordStartedAt = 0;
  let playbackRate = 1;
  let selectingLocked = false;
  /** @type {Map<number, Promise<{audio:string,mime:string}>>} */
  let audioCache = new Map();
  let prefetchReady = 0;

  const escapeHtml = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );

  const setStatus = (el, message, isError = false) => {
    el.textContent = message || "";
    el.classList.toggle("error", Boolean(isError));
  };

  const showPanel = (panel) => {
    homePanel.classList.toggle("hidden", panel !== "home");
    examPanel.classList.toggle("hidden", panel !== "exam");
    summaryPanel.classList.toggle("hidden", panel !== "summary");
    selectingLocked = panel === "exam";
    renderTopics();
  };

  const updateProgress = () => {
    const total = session?.questions?.length || 8;
    const done = Math.min(index, total);
    progressCount.textContent = String(done);
    progressLabel.textContent = `/ ${total}`;
    progressFill.style.transform = `scaleX(${total ? done / total : 0})`;
  };

  const persistTopics = () => {
    localStorage.setItem(
      topicsStorageKey,
      JSON.stringify([...selectedTopicIds]),
    );
  };

  const updateSelectionSummary = () => {
    if (!selectedTopicIds.size) {
      selectionSummary.textContent = "Random 2 topics";
      return;
    }
    const names = topicsCatalog
      .filter((t) => selectedTopicIds.has(t.id))
      .map((t) => t.name);
    selectionSummary.textContent = `${names.length} selected · ${names.join(", ")}`;
  };

  const renderTopics = (highlightIds = null) => {
    const active = highlightIds
      ? new Set(highlightIds)
      : selectingLocked && session
        ? new Set(session.topics.map((t) => t.id))
        : selectedTopicIds;

    topicList.innerHTML = topicsCatalog
      .map((topic) => {
        const picked = active.has(topic.id);
        return `<button type="button" class="topic-button${picked ? " picked" : ""}" data-id="${escapeHtml(topic.id)}" ${selectingLocked ? "disabled" : ""}>
          <span>${escapeHtml(topic.name)}</span>
          <span class="topic-count">${topic.count}</span>
        </button>`;
      })
      .join("");
    updateSelectionSummary();
  };

  const stopPlayback = () => {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
  };

  const playAudioUrl = async (url, revokeOnEnd = false) => {
    stopPlayback();
    const audio = new Audio(url);
    audio.playbackRate = playbackRate;
    currentAudio = audio;
    await new Promise((resolve, reject) => {
      audio.onended = () => {
        if (revokeOnEnd) URL.revokeObjectURL(url);
        resolve();
      };
      audio.onerror = () => {
        if (revokeOnEnd) URL.revokeObjectURL(url);
        reject(new Error("Audio playback failed"));
      };
      audio.play().catch(reject);
    });
  };

  const playBase64Audio = async (b64, mime = "audio/wav") => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    await playAudioUrl(url, true);
  };

  const apiJson = async (url, options = {}) => {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const fetchTts = async (text) => {
    let attempt = 0;
    while (attempt < 4) {
      attempt += 1;
      const res = await fetch("api/speak.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        return data;
      }
      const retryAfter = Number(data.retry_after) || 22;
      if (res.status === 429 || /rate/i.test(String(data.error || ""))) {
        setStatus(
          examStatus,
          `TTS limit — waiting ${retryAfter}s…`,
        );
        await sleep(retryAfter * 1000);
        continue;
      }
      throw new Error(data.error || `TTS failed (${res.status})`);
    }
    throw new Error("TTS rate limit exceeded. Wait a minute and continue.");
  };

  const ensureAudio = (qi) => {
    if (!session?.questions?.[qi]) {
      return Promise.reject(new Error("No question"));
    }
    if (audioCache.has(qi)) return audioCache.get(qi);
    const text = session.questions[qi].question;
    const promise = fetchTts(text)
      .then((data) => {
        prefetchReady += 1;
        return {
          audio: data.audio || null,
          mime: data.mime || "audio/mpeg",
          url: data.url || null,
          source: data.source || null,
        };
      })
      .catch((err) => {
        audioCache.delete(qi);
        throw err;
      });
    audioCache.set(qi, promise);
    return promise;
  };

  /** Prefetch remaining question audio in the background (static files are instant). */
  const prefetchRestAudio = () => {
    if (!session?.questions?.length) return;
    const chain = async () => {
      for (let qi = 0; qi < session.questions.length; qi += 1) {
        try {
          await ensureAudio(qi);
        } catch {
          // retry on demand when that question is shown
        }
      }
    };
    return chain();
  };

  const speakQuestionAt = async (qi) => {
    setStatus(examStatus, "Examiner is speaking…");
    const data = await ensureAudio(qi);
    if (data.url) {
      await playAudioUrl(data.url);
    } else if (data.audio) {
      await playBase64Audio(data.audio, data.mime);
    } else {
      throw new Error("No audio for this question");
    }
    setStatus(
      examStatus,
      "Your turn — press the button and answer in one sentence.",
    );
  };

  const currentQuestion = () => session?.questions?.[index] || null;

  const setBusyUi = (on) => {
    replayBtn.disabled = on;
    recordBtn.disabled = on;
    skipBtn.disabled = on;
    nextBtn.disabled = on;
  };

  const renderQuestion = async ({ autoSpeak = true } = {}) => {
    const q = currentQuestion();
    if (!q) {
      finishSession();
      return;
    }

    answerBox.classList.add("hidden");
    feedbackBox.classList.add("hidden");
    answerText.textContent = "";
    feedbackBox.innerHTML = "";

    const total = session.questions.length;
    qMeta.textContent = `Question ${index + 1} of ${total}`;
    qTopic.textContent = q.topic;
    qText.textContent = q.question;
    qText.classList.toggle("hidden-q", !showQuestionText);

    topicChips.innerHTML = session.topics
      .map(
        (t) =>
          `<span class="topic-chip${t.id === q.topicId ? " active" : ""}">${escapeHtml(t.name)}</span>`,
      )
      .join("");

    pageTitle.textContent = q.topic;
    topMeta.innerHTML = `Speaking <strong>${escapeHtml(q.topic)}</strong>`;
    updateProgress();
    renderTopics(session.topics.map((t) => t.id));

    // Warm only the next question — free tier can't handle parallel bursts.
    ensureAudio(index + 1).catch(() => {});

    if (autoSpeak) {
      try {
        busy = true;
        setBusyUi(true);
        if (!audioCache.has(index)) {
          setStatus(examStatus, "Preparing examiner audio…");
        }
        await speakQuestionAt(index);
      } catch (err) {
        setStatus(examStatus, err.message, true);
      } finally {
        busy = false;
        setBusyUi(false);
      }
    }
  };

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

  const startRecording = async () => {
    if (busy || mediaRecorder) return;
    stopPlayback();
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.start();
      recordBtn.classList.add("recording");
      recordBtn.textContent = "Stop · listening…";
      setStatus(examStatus, "Recording — press again or release to stop.");
    } catch {
      setStatus(examStatus, "Microphone permission needed.", true);
    }
  };

  const stopRecording = async () => {
    if (!mediaRecorder) return;
    const recorder = mediaRecorder;
    mediaRecorder = null;
    recordPointerId = null;

    const blob = await new Promise((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      };
      recorder.stop();
    });

    mediaStream?.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    recordBtn.classList.remove("recording");
    recordBtn.textContent = "Press to answer";

    if (blob.size < 800) {
      setStatus(examStatus, "Recording too short — try again.", true);
      return;
    }

    await processAnswer(blob);
  };

  const processAnswer = async (blob) => {
    const q = currentQuestion();
    if (!q) return;

    busy = true;
    setBusyUi(true);
    setStatus(examStatus, "Transcribing with Google AI…");

    try {
      const dataUrl = await blobToBase64(blob);
      const listen = await apiJson("api/listen.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: dataUrl, mime: blob.type || "audio/webm" }),
      });

      const transcript = (listen.transcript || "").trim();
      answerText.textContent = transcript || "(no speech detected)";
      answerBox.classList.remove("hidden");

      let feedback = null;
      if (transcript) {
        setStatus(examStatus, "Checking answer…");
        try {
          feedback = await apiJson("api/evaluate.php", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: q.question, answer: transcript }),
          });
          feedbackBox.classList.remove("hidden");
          feedbackBox.innerHTML = `<strong>${feedback.score}/5</strong> · ${escapeHtml(feedback.note || "")}${
            feedback.better
              ? `<div style="margin-top:6px">Vzor: ${escapeHtml(feedback.better)}</div>`
              : ""
          }`;
        } catch {
          // Feedback is optional
        }
      }

      answers.push({
        ...q,
        answer: transcript,
        feedback,
      });

      setStatus(examStatus, "Ready for the next question.");
    } catch (err) {
      setStatus(examStatus, err.message, true);
    } finally {
      busy = false;
      setBusyUi(false);
    }
  };

  const clearAudioCache = () => {
    audioCache = new Map();
    prefetchReady = 0;
  };

  const finishSession = () => {
    stopPlayback();
    clearAudioCache();
    showPanel("summary");
    pageTitle.textContent = "Summary";
    topMeta.innerHTML = `Completed <strong>${answers.length} answers</strong>`;
    updateProgress();

    summaryList.innerHTML = answers
      .map(
        (item) => `<li>
          <p class="summary-q">${escapeHtml(item.topic)} · ${escapeHtml(item.question)}</p>
          <p class="summary-a">${escapeHtml(item.answer || "—")}</p>
          ${
            item.feedback?.note
              ? `<p class="summary-note">${escapeHtml(item.feedback.note)}</p>`
              : ""
          }
        </li>`,
      )
      .join("");
  };

  const buildSessionUrl = () => {
    const params = new URLSearchParams({ per: "4" });
    if (selectedTopicIds.size) {
      params.set("ids", [...selectedTopicIds].join(","));
    } else {
      params.set("topics", "2");
    }
    return `api/session.php?${params.toString()}`;
  };

  const startSession = async () => {
    setStatus(homeStatus, "Preparing exam session…");
    startBtn.disabled = true;
    try {
      session = await apiJson(buildSessionUrl());
      index = 0;
      answers = [];
      clearAudioCache();
      showPanel("exam");
      setStatus(homeStatus, "");
      setStatus(
        examStatus,
        `Preparing examiner audio (1/${session.questions.length})…`,
      );
      // One at a time: start after Q1 is ready; rest prefetch slowly in background.
      await ensureAudio(0);
      prefetchRestAudio();
      await renderQuestion({ autoSpeak: true });
    } catch (err) {
      setStatus(homeStatus, err.message, true);
      selectingLocked = false;
      renderTopics();
    } finally {
      startBtn.disabled = false;
    }
  };

  const syncRateSelects = (value) => {
    playbackRate = Number(value) || 1;
    speechRate.value = String(playbackRate);
    speechRateExam.value = String(playbackRate);
    localStorage.setItem(rateStorageKey, String(playbackRate));
    if (currentAudio) {
      currentAudio.playbackRate = playbackRate;
    }
  };

  const loadTopics = async () => {
    try {
      const data = await apiJson("api/topics.php");
      topicsCatalog = data.topics || [];

      try {
        const saved = JSON.parse(localStorage.getItem(topicsStorageKey) || "[]");
        if (Array.isArray(saved)) {
          selectedTopicIds = new Set(
            saved.filter((id) => topicsCatalog.some((t) => t.id === id)),
          );
        }
      } catch {
        selectedTopicIds = new Set();
      }

      renderTopics();
      const totalQs = topicsCatalog.reduce((sum, t) => sum + t.count, 0);
      progressCount.textContent = "0";
      progressLabel.textContent = `/ 8`;
      topMeta.innerHTML = `Bank <strong>${totalQs} questions · ${topicsCatalog.length} topics</strong>`;
    } catch (err) {
      setStatus(homeStatus, err.message, true);
    }
  };

  topicList.addEventListener("click", (e) => {
    if (selectingLocked) return;
    const btn = e.target.closest(".topic-button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;
    if (selectedTopicIds.has(id)) selectedTopicIds.delete(id);
    else selectedTopicIds.add(id);
    persistTopics();
    renderTopics();
  });

  clearTopicsBtn.addEventListener("click", () => {
    if (selectingLocked) return;
    selectedTopicIds.clear();
    persistTopics();
    renderTopics();
  });

  randomTwoBtn.addEventListener("click", () => {
    if (selectingLocked) return;
    const pool = [...topicsCatalog];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    selectedTopicIds = new Set(pool.slice(0, 2).map((t) => t.id));
    persistTopics();
    renderTopics();
  });

  speechRate.addEventListener("change", () => syncRateSelects(speechRate.value));
  speechRateExam.addEventListener("change", () =>
    syncRateSelects(speechRateExam.value),
  );

  const savedRate = localStorage.getItem(rateStorageKey);
  if (savedRate) syncRateSelects(savedRate);

  startBtn.addEventListener("click", startSession);
  againBtn.addEventListener("click", startSession);
  homeBtn.addEventListener("click", () => {
    stopPlayback();
    clearAudioCache();
    showPanel("home");
    pageTitle.textContent = "Otázky";
    index = 0;
    session = null;
    updateProgress();
    const totalQs = topicsCatalog.reduce((sum, t) => sum + t.count, 0);
    topMeta.innerHTML = `Bank <strong>${totalQs} questions · ${topicsCatalog.length} topics</strong>`;
  });

  showQuestionsToggle.addEventListener("click", () => {
    showQuestionText = !showQuestionText;
    showQuestionsToggle.textContent = showQuestionText
      ? "Hide question text"
      : "Show question text";
    qText.classList.toggle("hidden-q", !showQuestionText);
  });

  replayBtn.addEventListener("click", async () => {
    const q = currentQuestion();
    if (!q || busy) return;
    try {
      busy = true;
      setBusyUi(true);
      await speakQuestionAt(index);
    } catch (err) {
      setStatus(examStatus, err.message, true);
    } finally {
      busy = false;
      setBusyUi(false);
    }
  });

  recordBtn.addEventListener("pointerdown", (e) => {
    if (busy) return;
    e.preventDefault();
    recordBtn.setPointerCapture?.(e.pointerId);
    recordPointerId = e.pointerId;
    if (mediaRecorder) {
      stopRecording();
      recordPointerId = null;
      return;
    }
    recordStartedAt = Date.now();
    startRecording();
  });
  recordBtn.addEventListener("pointerup", (e) => {
    e.preventDefault();
    if (recordPointerId !== e.pointerId) return;
    const heldMs = Date.now() - recordStartedAt;
    recordPointerId = null;
    if (heldMs >= 400 && mediaRecorder) {
      stopRecording();
    }
  });
  recordBtn.addEventListener("pointercancel", () => {
    recordPointerId = null;
    if (mediaRecorder) stopRecording();
  });

  nextBtn.addEventListener("click", async () => {
    if (busy) return;
    index += 1;
    updateProgress();
    if (index >= (session?.questions?.length || 0)) {
      finishSession();
      return;
    }
    await renderQuestion({ autoSpeak: true });
  });

  skipBtn.addEventListener("click", async () => {
    if (busy) return;
    const q = currentQuestion();
    if (q) {
      answers.push({ ...q, answer: "(skipped)", feedback: null });
    }
    index += 1;
    updateProgress();
    if (index >= (session?.questions?.length || 0)) {
      finishSession();
      return;
    }
    await renderQuestion({ autoSpeak: true });
  });

  stopExamBtn.addEventListener("click", () => {
    if (session) finishSession();
  });

  loadTopics();
})();
