(() => {
  const topicList = document.querySelector("#topicList");
  const homePanelT1 = document.querySelector("#homePanelT1");
  const homePanelT2 = document.querySelector("#homePanelT2");
  const examPanel = document.querySelector("#examPanel");
  const summaryPanel = document.querySelector("#summaryPanel");
  const startBtnT1 = document.querySelector("#startBtnT1");
  const startBtnT2 = document.querySelector("#startBtnT2");
  const showQuestionsToggle = document.querySelector("#showQuestionsToggle");
  const homeStatusT1 = document.querySelector("#homeStatusT1");
  const homeStatusT2 = document.querySelector("#homeStatusT2");
  const examStatus = document.querySelector("#examStatus");
  const topicChips = document.querySelector("#topicChips");
  const scenarioCard = document.querySelector("#scenarioCard");
  const scenarioSituation = document.querySelector("#scenarioSituation");
  const scenarioHints = document.querySelector("#scenarioHints");
  const qMeta = document.querySelector("#qMeta");
  const qTopic = document.querySelector("#qTopic");
  const qSection = document.querySelector("#qSection");
  const qPrompt = document.querySelector("#qPrompt");
  const qText = document.querySelector("#qText");
  const answerLabel = document.querySelector("#answerLabel");
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
  const crumb = document.querySelector("#crumb");
  const sidebarNavLabel = document.querySelector("#sidebarNavLabel");
  const sidebarFoot = document.querySelector("#sidebarFoot");
  const speechRate = document.querySelector("#speechRate");
  const speechRateT2 = document.querySelector("#speechRateT2");
  const speechRateExam = document.querySelector("#speechRateExam");
  const voiceGender = document.querySelector("#voiceGender");
  const voiceGenderExam = document.querySelector("#voiceGenderExam");
  const voiceGenderExamWrap = document.querySelector("#voiceGenderExamWrap");
  const selectionSummary = document.querySelector("#selectionSummary");
  const selectionSummaryT2 = document.querySelector("#selectionSummaryT2");
  const clearTopicsBtn = document.querySelector("#clearTopicsBtn");
  const randomTwoBtn = document.querySelector("#randomTwoBtn");
  const questionCountSelect = document.querySelector("#questionCount");
  const questionCountField = document.querySelector("#questionCountField");
  const questionOrderSelect = document.querySelector("#questionOrder");
  const taskTabs = document.querySelectorAll(".task-tab");

  const rateStorageKey = "speaking-t1-speech-rate";
  const topicsStorageKey = "speaking-t1-selected-topics";
  const dialoguesStorageKey = "speaking-t2-selected-dialogues";
  const questionCountStorageKey = "speaking-t1-question-count";
  const questionOrderStorageKey = "speaking-t1-question-order";
  const genderStorageKey = "speaking-t1-voice-gender";
  const taskStorageKey = "speaking-active-task";

  /** @type {1|2} */
  let activeTask = 1;
  let topicsCatalog = [];
  let dialoguesCatalog = [];
  let selectedTopicIds = new Set();
  let selectedDialogueIds = new Set();
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
  /** @type {"male"|"female"} */
  let askedGender = "male";
  let questionCount = 4;
  /** @type {"random"|"sequential"} */
  let questionOrder = "random";
  let selectingLocked = false;
  /** @type {Map<string, Promise<{audio:string,mime:string,url?:string|null,spoken?:string}>>} */
  let audioCache = new Map();
  let prefetchReady = 0;
  /** @type {Promise<void>[]} */
  let pendingGrades = [];
  let gradeQueue = Promise.resolve();
  /** Last examiner line spoken (for Replay on T2 opening/reply). */
  let lastSpokenText = "";

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

  /** Resolve bank slash forms (rád/a, nemocný/á, …) for display — mirrors PHP/Python. */
  const resolveGenderForm = (text, gender) => {
    let t = String(text || "").trim();
    const special = { "vdaná/ženatý": { male: "ženatý", female: "vdaná" } };
    for (const [pair, forms] of Object.entries(special)) {
      t = t.split(pair).join(forms[gender] || forms.male);
    }
    t = t.split("ý/á").join(gender === "female" ? "á" : "ý");
    t = t.replace(/\/a\b/g, gender === "female" ? "a" : "");
    t = t.replace(/\//g, " nebo ");
    return t.replace(/ {2,}/g, " ");
  };

  const homeStatus = () => (activeTask === 2 ? homeStatusT2 : homeStatusT1);

  const setStatus = (el, message, isError = false) => {
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("error", Boolean(isError));
  };

  const showPanel = (panel) => {
    const onHome = panel === "home";
    homePanelT1.classList.toggle("hidden", !(onHome && activeTask === 1));
    homePanelT2.classList.toggle("hidden", !(onHome && activeTask === 2));
    examPanel.classList.toggle("hidden", panel !== "exam");
    summaryPanel.classList.toggle("hidden", panel !== "summary");
    selectingLocked = panel === "exam";
    renderSidebarList();
  };

  const askTurns = () =>
    (session?.turns || []).filter((t) => t.kind === "ask");

  const currentTurn = () => session?.turns?.[index] || null;

  const currentQuestion = () => {
    if (activeTask === 2) return null;
    return session?.questions?.[index] || null;
  };

  const updateProgress = () => {
    if (activeTask === 2) {
      const asks = askTurns();
      const doneAsks = answers.length;
      const total = session?.totalAsks || asks.length || 8;
      progressCount.textContent = String(Math.min(doneAsks, total));
      progressLabel.textContent = `/ ${total}`;
      progressFill.style.transform = `scaleX(${total ? doneAsks / total : 0})`;
      return;
    }
    const total = session?.questions?.length || questionCount;
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

  const persistDialogues = () => {
    localStorage.setItem(
      dialoguesStorageKey,
      JSON.stringify([...selectedDialogueIds]),
    );
  };

  const updateSelectionSummary = () => {
    if (activeTask === 2) {
      if (!selectedDialogueIds.size) {
        selectionSummaryT2.textContent = "Random 2 dialogues";
        return;
      }
      const names = dialoguesCatalog
        .filter((d) => selectedDialogueIds.has(d.id))
        .map((d) => d.title);
      selectionSummaryT2.textContent = `${names.length} selected · ${names.join(", ")}`;
      return;
    }
    if (!selectedTopicIds.size) {
      selectionSummary.textContent =
        questionOrder === "sequential"
          ? "Random 2 topics · all Q in order"
          : "Random 2 topics";
      return;
    }
    const picked = topicsCatalog.filter((t) => selectedTopicIds.has(t.id));
    const names = picked.map((t) => t.name);
    const qTotal = picked.reduce((sum, t) => sum + t.count, 0);
    selectionSummary.textContent =
      questionOrder === "sequential"
        ? `${names.length} selected · all ${qTotal} Q in order`
        : `${names.length} selected · ${names.join(", ")}`;
  };

  const renderSidebarList = (highlightIds = null) => {
    if (activeTask === 2) {
      const active = highlightIds
        ? new Set(highlightIds)
        : selectingLocked && session
          ? new Set((session.dialogues || []).map((d) => d.id))
          : selectedDialogueIds;

      topicList.innerHTML = dialoguesCatalog
        .map((d) => {
          const picked = active.has(d.id);
          return `<button type="button" class="topic-button${picked ? " picked" : ""}" data-id="${escapeHtml(d.id)}" ${selectingLocked ? "disabled" : ""}>
            <span>${escapeHtml(d.title)}</span>
            <span class="topic-count">4 Q</span>
          </button>`;
        })
        .join("");
      updateSelectionSummary();
      return;
    }

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

  const applyTaskChrome = () => {
    taskTabs.forEach((tab) => {
      const on = Number(tab.dataset.task) === activeTask;
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (activeTask === 2) {
      crumb.innerHTML = `Study desk <span aria-hidden="true">/</span> Speaking T2`;
      sidebarNavLabel.textContent = "Pick situations · or leave empty for random 2";
      sidebarFoot.innerHTML = "A2 · TRVALÝ POBYT<br />MLUVENÍ · ÚLOHA 2";
      pageTitle.textContent = "Dialogy";
      document.title = "Čeština | A2 Speaking · Úloha 2";
      voiceGenderExamWrap?.classList.add("hidden");
      progressLabel.textContent = "/ 8";
      topMeta.innerHTML = `Practice <strong>2 dialogues · 8 questions</strong>`;
    } else {
      crumb.innerHTML = `Study desk <span aria-hidden="true">/</span> Speaking T1`;
      sidebarNavLabel.textContent = "Pick topics · or leave empty for random 2";
      sidebarFoot.innerHTML = "A2 · TRVALÝ POBYT<br />MLUVENÍ · ÚLOHA 1";
      pageTitle.textContent = "Otázky";
      document.title = "Čeština | A2 Speaking · Úloha 1";
      voiceGenderExamWrap?.classList.remove("hidden");
      syncQuestionCountUi();
    }
  };

  const setActiveTask = (task, { resetHome = true } = {}) => {
    if (selectingLocked) return;
    activeTask = task === 2 ? 2 : 1;
    localStorage.setItem(taskStorageKey, String(activeTask));
    applyTaskChrome();
    if (resetHome) {
      showPanel("home");
      setStatus(homeStatusT1, "");
      setStatus(homeStatusT2, "");
    }
    renderSidebarList();
    if (activeTask === 1) {
      const totalQs = topicsCatalog.reduce((sum, t) => sum + t.count, 0);
      topMeta.innerHTML = `Bank <strong>${totalQs} questions · ${topicsCatalog.length} topics</strong> · session <strong>${questionCount}</strong>`;
    } else {
      topMeta.innerHTML = `Bank <strong>${dialoguesCatalog.length} situations</strong> · session <strong>2 dialogues</strong>`;
    }
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
        body: JSON.stringify({ text, gender: askedGender }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        return data;
      }
      const retryAfter = Number(data.retry_after) || 22;
      if (res.status === 429 || /rate/i.test(String(data.error || ""))) {
        setStatus(examStatus, `TTS limit — waiting ${retryAfter}s…`);
        await sleep(retryAfter * 1000);
        continue;
      }
      throw new Error(data.error || `TTS failed (${res.status})`);
    }
    throw new Error("TTS rate limit exceeded. Wait a minute and continue.");
  };

  const audioCacheKey = (key) =>
    activeTask === 2 ? `t2:${key}` : `${askedGender}:${key}`;

  const ensureAudioText = (cacheKey, text) => {
    const key = audioCacheKey(cacheKey);
    if (audioCache.has(key)) return audioCache.get(key);
    const promise = fetchTts(text)
      .then((data) => {
        prefetchReady += 1;
        return {
          audio: data.audio || null,
          mime: data.mime || "audio/mpeg",
          url: data.url || null,
          source: data.source || null,
          spoken: data.spoken || text,
        };
      })
      .catch((err) => {
        audioCache.delete(key);
        throw err;
      });
    audioCache.set(key, promise);
    return promise;
  };

  const ensureAudio = (qi) => {
    if (!session?.questions?.[qi]) {
      return Promise.reject(new Error("No question"));
    }
    const text = session.questions[qi].question;
    return ensureAudioText(String(qi), text).then((data) => ({
      ...data,
      spoken: data.spoken || resolveGenderForm(text, askedGender),
    }));
  };

  const prefetchRestAudio = () => {
    if (activeTask === 2) {
      if (!session?.turns?.length) return;
      const chain = async () => {
        for (let i = 0; i < session.turns.length; i += 1) {
          const t = session.turns[i];
          try {
            if (t.kind === "opening" || t.kind === "closing") {
              await ensureAudioText(`turn-${i}`, t.text);
            } else if (t.kind === "ask" && t.reply) {
              await ensureAudioText(`reply-${i}`, t.reply);
            }
          } catch {
            // retry on demand
          }
        }
      };
      return chain();
    }
    if (!session?.questions?.length) return;
    const chain = async () => {
      for (let qi = 0; qi < session.questions.length; qi += 1) {
        try {
          await ensureAudio(qi);
        } catch {
          // retry on demand
        }
      }
    };
    return chain();
  };

  const playSpoken = async (cacheKey, text) => {
    lastSpokenText = text;
    setStatus(examStatus, "Examiner is speaking…");
    const data = await ensureAudioText(cacheKey, text);
    if (data.url) {
      await playAudioUrl(data.url);
    } else if (data.audio) {
      await playBase64Audio(data.audio, data.mime);
    } else {
      throw new Error("No audio");
    }
  };

  const speakQuestionAt = async (qi) => {
    setStatus(examStatus, "Examiner is speaking…");
    const data = await ensureAudio(qi);
    lastSpokenText = data.spoken || session.questions[qi].question;
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

  const setBusyUi = (on) => {
    replayBtn.disabled = on;
    recordBtn.disabled = on;
    if (skipBtn) skipBtn.disabled = on;
    if (nextBtn) nextBtn.disabled = on;
  };

  const renderScenarioCard = (turn) => {
    if (!turn || activeTask !== 2) {
      scenarioCard.classList.add("hidden");
      return;
    }
    scenarioCard.classList.remove("hidden");
    scenarioSituation.textContent = turn.situation || "—";
    const hints = turn.hints || [];
    scenarioHints.innerHTML = hints
      .map((h, i) => {
        const active = turn.hintIndex === i;
        return `<li class="${active ? "active" : ""}">${escapeHtml(h)}</li>`;
      })
      .join("");
  };

  const renderQuestion = async ({ autoSpeak = true } = {}) => {
    const q = currentQuestion();
    if (!q) {
      finishSession();
      return;
    }

    scenarioCard.classList.add("hidden");
    answerBox.classList.add("hidden");
    feedbackBox.classList.add("hidden");
    answerText.textContent = "";
    feedbackBox.innerHTML = "";
    answerLabel.textContent = "Vaše odpověď";
    qPrompt.textContent = "Poslouchejte otázku a odpovězte celou větou.";
    recordBtn.textContent = "Press to answer";

    const total = session.questions.length;
    qMeta.textContent = `Question ${index + 1} of ${total}`;
    qTopic.textContent = q.topic;
    if (q.subtopic) {
      qSection.textContent = q.subtopic;
      qSection.classList.remove("hidden");
    } else {
      qSection.textContent = "";
      qSection.classList.add("hidden");
    }
    qText.textContent = resolveGenderForm(q.question, askedGender);
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
    renderSidebarList(session.topics.map((t) => t.id));

    ensureAudio(index + 1).catch(() => {});

    if (autoSpeak) {
      try {
        busy = true;
        setBusyUi(true);
        if (!audioCache.has(audioCacheKey(String(index)))) {
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

  const renderT2Turn = async ({ autoSpeak = true } = {}) => {
    const turn = currentTurn();
    if (!turn) {
      finishSession();
      return;
    }

    answerBox.classList.add("hidden");
    feedbackBox.classList.add("hidden");
    answerText.textContent = "";
    feedbackBox.innerHTML = "";
    answerLabel.textContent = "Vaše otázka";
    qSection?.classList.add("hidden");
    renderScenarioCard(turn);

    topicChips.innerHTML = (session.dialogues || [])
      .map(
        (d) =>
          `<span class="topic-chip${d.id === turn.dialogueId ? " active" : ""}">${escapeHtml(d.title)}</span>`,
      )
      .join("");

    pageTitle.textContent = turn.dialogueTitle || "Dialog";
    topMeta.innerHTML = `Dialogue <strong>${(turn.dialogueIndex || 0) + 1}/${(session.dialogues || []).length}</strong>`;
    updateProgress();
    renderSidebarList((session.dialogues || []).map((d) => d.id));

    if (turn.kind === "opening") {
      qMeta.textContent = `Dialog ${(turn.dialogueIndex || 0) + 1} · opening`;
      qTopic.textContent = turn.dialogueTitle;
      qPrompt.textContent = "Poslouchejte tazatele — pak se ptejte podle karty.";
      qText.textContent = turn.text;
      qText.classList.remove("hidden-q");
      recordBtn.classList.add("hidden");
      skipBtn?.classList.add("hidden");
      replayBtn.textContent = "Replay greeting";

      if (autoSpeak) {
        try {
          busy = true;
          setBusyUi(true);
          await playSpoken(`turn-${index}`, turn.text);
          setStatus(examStatus, "Your turn — ask the first question from the card.");
          // Auto-advance to first ask after greeting
          index += 1;
          await renderT2Turn({ autoSpeak: false });
          setStatus(
            examStatus,
            "Press the button and ask your question (formal vy).",
          );
        } catch (err) {
          setStatus(examStatus, err.message, true);
        } finally {
          busy = false;
          setBusyUi(false);
        }
      }
      return;
    }

    if (turn.kind === "closing") {
      qMeta.textContent = `Dialog ${(turn.dialogueIndex || 0) + 1} · closing`;
      qTopic.textContent = turn.dialogueTitle;
      qPrompt.textContent = "Konec dialogu.";
      qText.textContent = turn.text;
      qText.classList.remove("hidden-q");
      recordBtn.classList.add("hidden");
      skipBtn?.classList.add("hidden");
      replayBtn.textContent = "Replay";

      if (autoSpeak) {
        try {
          busy = true;
          setBusyUi(true);
          await playSpoken(`turn-${index}`, turn.text);
          index += 1;
          if (index >= session.turns.length) {
            setStatus(examStatus, "Scoring your questions…");
            await Promise.allSettled(pendingGrades);
            await finishSession();
            return;
          }
          await renderT2Turn({ autoSpeak: true });
        } catch (err) {
          setStatus(examStatus, err.message, true);
        } finally {
          busy = false;
          setBusyUi(false);
        }
      }
      return;
    }

    // ask turn
    const askNum = answers.length + 1;
    const totalAsks = session.totalAsks || 8;
    qMeta.textContent = `Question ${askNum} of ${totalAsks}`;
    qTopic.textContent = turn.isFree
      ? "Vaše otázka"
      : turn.hint || "Zeptejte se";
    qPrompt.textContent = turn.isFree
      ? "Vymyslete vlastní otázku k této situaci (formální vy)."
      : `Zeptejte se podle nápovědy: ${turn.hint}`;
    qText.textContent = turn.isFree
      ? "…? (vaše otázka)"
      : turn.model_question || turn.hint;
    // On exam, model question is a hint only if user opts in — keep visible as guide for practice
    qText.classList.toggle("hidden-q", false);
    qText.classList.add("model-hint");
    recordBtn.classList.remove("hidden");
    skipBtn?.classList.remove("hidden");
    recordBtn.textContent = "Press to ask";
    replayBtn.textContent = "Replay last";

    // Prefetch reply
    if (turn.reply) {
      ensureAudioText(`reply-${index}`, turn.reply).catch(() => {});
    }

    if (!autoSpeak) {
      setStatus(
        examStatus,
        "Your turn — press the button and ask your question (formal vy).",
      );
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
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      chunks = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      try {
        mediaRecorder = new MediaRecorder(mediaStream, {
          mimeType: mime,
          audioBitsPerSecond: 24000,
        });
      } catch {
        mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
      }
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.start();
      recordBtn.classList.add("recording");
      recordBtn.textContent =
        activeTask === 2 ? "Stop · listening…" : "Stop · listening…";
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
    recordBtn.textContent =
      activeTask === 2 ? "Press to ask" : "Press to answer";

    if (blob.size < 800) {
      setStatus(examStatus, "Recording too short — try again.", true);
      return;
    }

    if (activeTask === 2) {
      await processAsk(blob);
    } else {
      await processAnswer(blob);
    }
  };

  const showAttemptFeedback = (transcript, feedback) => {
    answerText.textContent = transcript || "(no speech detected)";
    answerBox.classList.remove("hidden");
    if (feedback) {
      const score = Number(feedback.score) || 0;
      feedbackBox.classList.remove("hidden");
      feedbackBox.innerHTML = `<strong>${score}/5</strong> · ${escapeHtml(feedback.note || "")}${
        feedback.better
          ? `<div style="margin-top:6px">Model: ${escapeHtml(feedback.better)}</div>`
          : ""
      }`;
    } else {
      feedbackBox.classList.add("hidden");
      feedbackBox.innerHTML = "";
    }
  };

  const gradeAnswer = async (blob, questionText) => {
    const dataUrl = await blobToBase64(blob);
    let attempt = 0;
    let data = null;
    while (attempt < 3) {
      attempt += 1;
      const res = await fetch("api/answer.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: dataUrl,
          mime: blob.type || "audio/webm",
          question: questionText,
          mode: "answer",
        }),
      });
      data = await res.json().catch(() => ({}));
      if (res.ok) break;
      if (res.status === 429) {
        await sleep((Number(data.retry_after) || 20) * 1000);
        continue;
      }
      throw new Error(data.error || `Grading failed (${res.status})`);
    }
    if (!data || data.error) {
      throw new Error(data?.error || "Grading failed");
    }
    const transcript = (data.transcript || "").trim();
    return {
      transcript,
      feedback: data.feedback || {
        ok: false,
        score: 0,
        note: "No feedback returned",
        better: null,
      },
    };
  };

  const gradeAsk = async (blob, turn) => {
    const dataUrl = await blobToBase64(blob);
    let attempt = 0;
    let data = null;
    while (attempt < 3) {
      attempt += 1;
      const res = await fetch("api/answer.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: dataUrl,
          mime: blob.type || "audio/webm",
          mode: "ask",
          situation: turn.situation || "",
          hint: turn.hint || "",
          model_question: turn.model_question || "",
          is_free: Boolean(turn.isFree),
        }),
      });
      data = await res.json().catch(() => ({}));
      if (res.ok) break;
      if (res.status === 429) {
        await sleep((Number(data.retry_after) || 20) * 1000);
        continue;
      }
      throw new Error(data.error || `Grading failed (${res.status})`);
    }
    if (!data || data.error) {
      throw new Error(data?.error || "Grading failed");
    }
    const transcript = (data.transcript || "").trim();
    return {
      transcript,
      feedback: data.feedback || {
        ok: false,
        score: 0,
        note: "No feedback returned",
        better: turn.model_question || null,
      },
    };
  };

  const enqueueGrade = (task) => {
    const run = gradeQueue.then(task, task);
    gradeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    pendingGrades.push(run);
    return run;
  };

  const advanceAfterAnswer = async () => {
    index += 1;
    updateProgress();
    if (index >= (session?.questions?.length || 0)) {
      setStatus(examStatus, "Scoring your answers…");
      busy = true;
      setBusyUi(true);
      await Promise.allSettled(pendingGrades);
      busy = false;
      setBusyUi(false);
      await finishSession();
      return;
    }
    setStatus(examStatus, "Next question…");
    await renderQuestion({ autoSpeak: true });
  };

  const processAnswer = async (blob) => {
    const q = currentQuestion();
    if (!q) return;

    const slot = {
      ...q,
      answer: "(scoring…)",
      feedback: {
        ok: false,
        score: 0,
        note: "Scoring in background…",
        better: null,
      },
      pending: true,
    };
    answers.push(slot);

    enqueueGrade(async () => {
      try {
        const { transcript, feedback } = await gradeAnswer(blob, q.question);
        slot.answer = transcript || "(no speech detected)";
        slot.feedback = feedback;
        slot.pending = false;
        if (examPanel && !examPanel.classList.contains("hidden")) {
          const score = Number(feedback?.score) || 0;
          const note = String(feedback?.note || "").slice(0, 80);
          setStatus(
            examStatus,
            `Scored previous: ${score}/5${note ? ` · ${note}` : ""}`,
          );
        }
      } catch (err) {
        slot.answer = "(scoring failed)";
        slot.feedback = {
          ok: false,
          score: 0,
          note: err.message || "Scoring failed",
          better: null,
        };
        slot.pending = false;
      }
    });

    await advanceAfterAnswer();
  };

  const processAsk = async (blob) => {
    const turn = currentTurn();
    if (!turn || turn.kind !== "ask") return;

    const slot = {
      task: 2,
      dialogueId: turn.dialogueId,
      dialogueTitle: turn.dialogueTitle,
      situation: turn.situation,
      hint: turn.hint,
      isFree: Boolean(turn.isFree),
      model_question: turn.model_question,
      question: turn.model_question || turn.hint,
      topic: turn.dialogueTitle,
      answer: "(scoring…)",
      feedback: {
        ok: false,
        score: 0,
        note: "Scoring in background…",
        better: turn.model_question || null,
      },
      pending: true,
    };
    answers.push(slot);
    updateProgress();

    enqueueGrade(async () => {
      try {
        const { transcript, feedback } = await gradeAsk(blob, turn);
        slot.answer = transcript || "(no speech detected)";
        slot.feedback = feedback;
        slot.pending = false;
        if (examPanel && !examPanel.classList.contains("hidden")) {
          const score = Number(feedback?.score) || 0;
          const note = String(feedback?.note || "").slice(0, 80);
          setStatus(
            examStatus,
            `Scored previous: ${score}/5${note ? ` · ${note}` : ""}`,
          );
        }
      } catch (err) {
        slot.answer = "(scoring failed)";
        slot.feedback = {
          ok: false,
          score: 0,
          note: err.message || "Scoring failed",
          better: turn.model_question || null,
        };
        slot.pending = false;
      }
    });

    // Examiner replies, then next turn
    try {
      busy = true;
      setBusyUi(true);
      if (turn.reply) {
        await playSpoken(`reply-${index}`, turn.reply);
      }
      index += 1;
      if (index >= (session?.turns?.length || 0)) {
        setStatus(examStatus, "Scoring your questions…");
        await Promise.allSettled(pendingGrades);
        await finishSession();
        return;
      }
      await renderT2Turn({ autoSpeak: true });
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

  const finishSession = async () => {
    stopPlayback();
    clearAudioCache();
    showPanel("summary");
    pageTitle.textContent = "Summary";
    const scored = answers.filter(
      (a) => !a.pending && (Number(a.feedback?.score) || 0) > 0,
    );
    topMeta.innerHTML = `Answered <strong>${answers.length}</strong> · scored <strong>${scored.length}</strong>`;
    updateProgress();

    summaryList.innerHTML = answers.length
      ? answers
          .map((item) => {
            const head =
              activeTask === 2
                ? `${escapeHtml(item.dialogueTitle || item.topic)} · ${escapeHtml(item.isFree ? "vaše otázka" : item.hint || "")}`
                : `${escapeHtml(item.topic)} · ${escapeHtml(resolveGenderForm(item.question, askedGender))}`;
            const model =
              activeTask === 2 && item.model_question
                ? `<p class="summary-note">Model: ${escapeHtml(item.model_question)}</p>`
                : "";
            return `<li>
          <p class="summary-q">${head}</p>
          <p class="summary-a">${escapeHtml(item.answer || "—")}</p>
          ${
            item.pending
              ? `<p class="summary-note">Still scoring…</p>`
              : item.feedback?.score
                ? `<p class="summary-note"><strong>${item.feedback.score}/5</strong> · ${escapeHtml(item.feedback.note || "")}</p>`
                : item.feedback?.note
                  ? `<p class="summary-note">${escapeHtml(item.feedback.note)}</p>`
                  : ""
          }
          ${model}
        </li>`;
          })
          .join("")
      : '<li><p class="summary-note">No answers yet.</p></li>';
    pendingGrades = [];
  };

  const syncQuestionCountUi = () => {
    if (questionCountSelect) {
      questionCountSelect.value = String(questionCount);
    }
    if (questionOrderSelect) {
      questionOrderSelect.value = questionOrder;
    }
    questionCountField?.classList.toggle("hidden", questionOrder === "sequential");
    if (activeTask === 1) {
      if (questionOrder === "sequential") {
        const picked = selectedTopicIds.size
          ? topicsCatalog.filter((t) => selectedTopicIds.has(t.id))
          : null;
        const n = picked
          ? picked.reduce((sum, t) => sum + t.count, 0)
          : "all";
        progressLabel.textContent = typeof n === "number" ? `/ ${n}` : "";
        topMeta.innerHTML = `Practice <strong>all questions in order</strong>`;
      } else {
        progressLabel.textContent = `/ ${questionCount}`;
        topMeta.innerHTML = `Practice <strong>${questionCount} questions</strong>`;
      }
    }
    updateSelectionSummary();
  };

  const setQuestionCount = (value) => {
    const n = Number(value) || 4;
    questionCount = Math.max(1, Math.min(20, n));
    localStorage.setItem(questionCountStorageKey, String(questionCount));
    syncQuestionCountUi();
  };

  const setQuestionOrder = (value) => {
    questionOrder = value === "sequential" ? "sequential" : "random";
    localStorage.setItem(questionOrderStorageKey, questionOrder);
    syncQuestionCountUi();
  };

  const buildSessionUrl = () => {
    const params = new URLSearchParams({ order: questionOrder });
    if (questionOrder !== "sequential") {
      params.set("total", String(questionCount));
    }
    if (selectedTopicIds.size) {
      params.set("ids", [...selectedTopicIds].join(","));
    } else {
      params.set("topics", "2");
    }
    return `api/session.php?${params.toString()}`;
  };

  const buildSessionT2Url = () => {
    const params = new URLSearchParams({ count: "2" });
    if (selectedDialogueIds.size) {
      params.set("ids", [...selectedDialogueIds].join(","));
    }
    return `api/session-t2.php?${params.toString()}`;
  };

  const startSessionT1 = async () => {
    setStatus(homeStatusT1, "Preparing exam session…");
    startBtnT1.disabled = true;
    try {
      session = await apiJson(buildSessionUrl());
      index = 0;
      answers = [];
      pendingGrades = [];
      gradeQueue = Promise.resolve();
      clearAudioCache();
      showPanel("exam");
      scenarioCard.classList.add("hidden");
      recordBtn.classList.remove("hidden");
      skipBtn?.classList.remove("hidden");
      replayBtn.textContent = "Replay question";
      setStatus(homeStatusT1, "");
      setStatus(
        examStatus,
        `Preparing examiner audio (1/${session.questions.length})…`,
      );
      await ensureAudio(0);
      prefetchRestAudio();
      await renderQuestion({ autoSpeak: true });
    } catch (err) {
      setStatus(homeStatusT1, err.message, true);
      selectingLocked = false;
      renderSidebarList();
    } finally {
      startBtnT1.disabled = false;
    }
  };

  const startSessionT2 = async () => {
    setStatus(homeStatusT2, "Preparing dialogue session…");
    startBtnT2.disabled = true;
    try {
      session = await apiJson(buildSessionT2Url());
      index = 0;
      answers = [];
      pendingGrades = [];
      gradeQueue = Promise.resolve();
      clearAudioCache();
      lastSpokenText = "";
      showPanel("exam");
      setStatus(homeStatusT2, "");
      setStatus(examStatus, "Preparing examiner…");
      // Prefetch first opening
      const first = session.turns?.[0];
      if (first?.kind === "opening") {
        await ensureAudioText("turn-0", first.text);
      }
      prefetchRestAudio();
      await renderT2Turn({ autoSpeak: true });
    } catch (err) {
      setStatus(homeStatusT2, err.message, true);
      selectingLocked = false;
      renderSidebarList();
    } finally {
      startBtnT2.disabled = false;
    }
  };

  const startSession = async () => {
    if (activeTask === 2) return startSessionT2();
    return startSessionT1();
  };

  const syncRateSelects = (value) => {
    playbackRate = Number(value) || 1;
    if (speechRate) speechRate.value = String(playbackRate);
    if (speechRateT2) speechRateT2.value = String(playbackRate);
    if (speechRateExam) speechRateExam.value = String(playbackRate);
    localStorage.setItem(rateStorageKey, String(playbackRate));
    if (currentAudio) {
      currentAudio.playbackRate = playbackRate;
    }
  };

  const syncGenderSelects = (value, { replay = false } = {}) => {
    askedGender = value === "female" ? "female" : "male";
    if (voiceGender) voiceGender.value = askedGender;
    if (voiceGenderExam) voiceGenderExam.value = askedGender;
    localStorage.setItem(genderStorageKey, askedGender);
    clearAudioCache();
    const q = currentQuestion();
    if (q) {
      qText.textContent = resolveGenderForm(q.question, askedGender);
    }
    if (
      replay &&
      activeTask === 1 &&
      session &&
      !examPanel.classList.contains("hidden") &&
      !busy
    ) {
      prefetchRestAudio();
      speakQuestionAt(index).catch((err) =>
        setStatus(examStatus, err.message, true),
      );
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
    } catch (err) {
      setStatus(homeStatusT1, err.message, true);
    }
  };

  const loadDialogues = async () => {
    try {
      const data = await apiJson("api/dialogues.php");
      dialoguesCatalog = data.dialogues || [];

      try {
        const saved = JSON.parse(
          localStorage.getItem(dialoguesStorageKey) || "[]",
        );
        if (Array.isArray(saved)) {
          selectedDialogueIds = new Set(
            saved.filter((id) => dialoguesCatalog.some((d) => d.id === id)),
          );
        }
      } catch {
        selectedDialogueIds = new Set();
      }
    } catch (err) {
      setStatus(homeStatusT2, err.message, true);
    }
  };

  topicList.addEventListener("click", (e) => {
    if (selectingLocked) return;
    const btn = e.target.closest(".topic-button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;
    if (activeTask === 2) {
      if (selectedDialogueIds.has(id)) selectedDialogueIds.delete(id);
      else selectedDialogueIds.add(id);
      persistDialogues();
    } else {
      if (selectedTopicIds.has(id)) selectedTopicIds.delete(id);
      else selectedTopicIds.add(id);
      persistTopics();
    }
    renderSidebarList();
  });

  clearTopicsBtn.addEventListener("click", () => {
    if (selectingLocked) return;
    if (activeTask === 2) {
      selectedDialogueIds.clear();
      persistDialogues();
    } else {
      selectedTopicIds.clear();
      persistTopics();
    }
    renderSidebarList();
  });

  randomTwoBtn.addEventListener("click", () => {
    if (selectingLocked) return;
    if (activeTask === 2) {
      const pool = [...dialoguesCatalog];
      for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      selectedDialogueIds = new Set(pool.slice(0, 2).map((d) => d.id));
      persistDialogues();
    } else {
      const pool = [...topicsCatalog];
      for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      selectedTopicIds = new Set(pool.slice(0, 2).map((t) => t.id));
      persistTopics();
    }
    renderSidebarList();
  });

  taskTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (selectingLocked) return;
      setActiveTask(Number(tab.dataset.task) === 2 ? 2 : 1);
    });
  });

  speechRate?.addEventListener("change", () => syncRateSelects(speechRate.value));
  speechRateT2?.addEventListener("change", () =>
    syncRateSelects(speechRateT2.value),
  );
  speechRateExam.addEventListener("change", () =>
    syncRateSelects(speechRateExam.value),
  );
  voiceGender?.addEventListener("change", () =>
    syncGenderSelects(voiceGender.value),
  );
  voiceGenderExam?.addEventListener("change", () =>
    syncGenderSelects(voiceGenderExam.value, { replay: true }),
  );
  questionCountSelect?.addEventListener("change", () =>
    setQuestionCount(questionCountSelect.value),
  );
  questionOrderSelect?.addEventListener("change", () =>
    setQuestionOrder(questionOrderSelect.value),
  );

  const savedRate = localStorage.getItem(rateStorageKey);
  if (savedRate) syncRateSelects(savedRate);
  const savedOrder = localStorage.getItem(questionOrderStorageKey);
  if (savedOrder === "sequential") questionOrder = "sequential";
  const savedCount = localStorage.getItem(questionCountStorageKey);
  if (savedCount) setQuestionCount(savedCount);
  else syncQuestionCountUi();
  const savedGender = localStorage.getItem(genderStorageKey);
  syncGenderSelects(savedGender === "female" ? "female" : "male");

  startBtnT1?.addEventListener("click", startSessionT1);
  startBtnT2?.addEventListener("click", startSessionT2);
  againBtn.addEventListener("click", startSession);
  homeBtn.addEventListener("click", () => {
    stopPlayback();
    clearAudioCache();
    showPanel("home");
    index = 0;
    session = null;
    answers = [];
    applyTaskChrome();
    updateProgress();
    if (activeTask === 2) {
      topMeta.innerHTML = `Bank <strong>${dialoguesCatalog.length} situations</strong> · session <strong>2 dialogues</strong>`;
    } else {
      const totalQs = topicsCatalog.reduce((sum, t) => sum + t.count, 0);
      topMeta.innerHTML = `Bank <strong>${totalQs} questions · ${topicsCatalog.length} topics</strong>`;
    }
  });

  showQuestionsToggle?.addEventListener("click", () => {
    showQuestionText = !showQuestionText;
    showQuestionsToggle.textContent = showQuestionText
      ? "Hide question text"
      : "Show question text";
    qText.classList.toggle("hidden-q", !showQuestionText);
  });

  replayBtn.addEventListener("click", async () => {
    if (busy) return;
    try {
      busy = true;
      setBusyUi(true);
      if (activeTask === 2) {
        const turn = currentTurn();
        if (turn?.kind === "ask" && lastSpokenText) {
          await playSpoken("replay-last", lastSpokenText);
          setStatus(
            examStatus,
            "Your turn — press the button and ask your question (formal vy).",
          );
        } else if (turn?.kind === "opening" || turn?.kind === "closing") {
          await playSpoken(`turn-${index}`, turn.text);
        } else if (lastSpokenText) {
          await playSpoken("replay-last", lastSpokenText);
        }
      } else {
        const q = currentQuestion();
        if (!q) return;
        await speakQuestionAt(index);
      }
    } catch (err) {
      setStatus(examStatus, err.message, true);
    } finally {
      busy = false;
      setBusyUi(false);
    }
  });

  recordBtn.addEventListener("pointerdown", (e) => {
    if (busy || recordBtn.classList.contains("hidden")) return;
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

  skipBtn?.addEventListener("click", async () => {
    if (busy) return;
    if (activeTask === 2) {
      const turn = currentTurn();
      if (!turn || turn.kind !== "ask") return;
      answers.push({
        task: 2,
        dialogueId: turn.dialogueId,
        dialogueTitle: turn.dialogueTitle,
        hint: turn.hint,
        isFree: Boolean(turn.isFree),
        model_question: turn.model_question,
        question: turn.model_question || turn.hint,
        topic: turn.dialogueTitle,
        answer: "(skipped)",
        feedback: { ok: false, score: 0, note: "Skipped", better: null },
        pending: false,
      });
      updateProgress();
      setStatus(examStatus, "Skipped — continuing…");
      try {
        busy = true;
        setBusyUi(true);
        if (turn.reply) {
          await playSpoken(`reply-${index}`, turn.reply);
        }
        index += 1;
        if (index >= (session?.turns?.length || 0)) {
          await Promise.allSettled(pendingGrades);
          await finishSession();
          return;
        }
        await renderT2Turn({ autoSpeak: true });
      } catch (err) {
        setStatus(examStatus, err.message, true);
      } finally {
        busy = false;
        setBusyUi(false);
      }
      return;
    }
    const q = currentQuestion();
    if (q) {
      answers.push({
        ...q,
        answer: "(skipped)",
        feedback: { ok: false, score: 0, note: "Skipped", better: null },
        pending: false,
      });
    }
    setStatus(examStatus, "Skipped — next question…");
    await advanceAfterAnswer();
  });

  nextBtn?.addEventListener("click", () => {
    if (busy) return;
    setStatus(
      examStatus,
      activeTask === 2
        ? "Ask a question or press Skip to continue."
        : "Answer or press Skip to continue.",
    );
  });

  stopExamBtn.addEventListener("click", async () => {
    if (!session) return;
    setStatus(examStatus, "Scoring…");
    busy = true;
    setBusyUi(true);
    await Promise.allSettled(pendingGrades);
    busy = false;
    setBusyUi(false);
    await finishSession();
  });

  (async () => {
    await Promise.all([loadTopics(), loadDialogues()]);
    const savedTask = localStorage.getItem(taskStorageKey);
    setActiveTask(savedTask === "2" ? 2 : 1, { resetHome: true });
  })();
})();
