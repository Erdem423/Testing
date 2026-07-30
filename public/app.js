(() => {
  "use strict";

  // ---------- DOM refs (things that exist once, regardless of folder count) ----------
  const folderTreeEl = document.getElementById("folder-tree");

  const runAllBtn = document.getElementById("run-all-btn");
  const runSelectedBtn = document.getElementById("run-selected-btn");
  const runSpinner = document.getElementById("run-spinner");
  const runSelectedLabel = document.getElementById("run-selected-label");

  const configWarning = document.getElementById("config-warning");
  const configErrors = document.getElementById("config-errors");

  const badgesEl = document.getElementById("badges");
  const passCountEl = document.getElementById("pass-count");
  const badgeFailEl = document.getElementById("badge-fail");
  const failCountEl = document.getElementById("fail-count");
  const badgePendingEl = document.getElementById("badge-pending");
  const pendingCountEl = document.getElementById("pending-count");
  const clearBtn = document.getElementById("clear-btn");

  const resultsListEl = document.getElementById("results-list");
  const emptyNoSelectionEl = document.getElementById("empty-no-selection");

  const detailEmptyEl = document.getElementById("detail-empty");
  const detailContentEl = document.getElementById("detail-content");
  const detailNameEl = document.getElementById("detail-name");
  const detailStatusBadgeEl = document.getElementById("detail-status-badge");
  const detailDurationEl = document.getElementById("detail-duration");
  const detailBodyEl = document.getElementById("detail-body");

  // ---------- State ----------
  // One entry per discovered folder. Each folder gets its OWN dynamically
  // built search input / select-all checkbox / scenario list elements (never
  // reusing a fixed singleton id) - this is what actually lets multiple
  // folders coexist on screen later without ID collisions, not just the
  // single Stripe folder we have today.
  //
  // folderStates[folderId] = {
  //   folder: { id, displayName, icon, scenarioCount },
  //   scenarios: [{ name, category, steps: string[] }],
  //   selected: Set<name>,
  //   results: { [name]: { status, duration, failureMessages } },
//   steps: { [scenarioName]: { [stepName]: { status, duration } } },
  //   search: string,
  //   activeResultName: string | null,
  //   hasRun: boolean,
  //   collapsed: boolean,
  //   el: { scenarioListEl, searchInputEl, selectAllCheckboxEl, totalCountEl, sectionBodyEl, chevronEl },
  // }
  let folderStates = {};

  // Center/right panes and the Run buttons operate on whichever folder was
  // most recently interacted with (checkbox toggled, search typed, etc).
  // With one folder this is trivially that folder; if a second folder is
  // ever added, interacting with either folder's checkboxes switches which
  // one drives the center/right panes and Run buttons.
  let currentFolderId = null;

  let isRunning = false;
  let configOk = false;

  function currentState() {
    return currentFolderId ? folderStates[currentFolderId] : null;
  }

  // ---------- Data loading ----------
  async function loadFolders() {
    const res = await fetch("/api/folders");
    const data = await res.json();

    folderTreeEl.innerHTML = "";
    folderStates = {};

    for (const folder of data.folders) {
      await addFolderSection(folder);
    }

    if (data.folders.length > 0 && !currentFolderId) {
      currentFolderId = data.folders[0].id;
    }
    renderCenterList();
    renderRightPanel();
    updateButtonStates();
  }

  async function addFolderSection(folder) {
    const scenariosRes = await fetch(`/api/scenarios?folder=${encodeURIComponent(folder.id)}`);
    const scenariosData = await scenariosRes.json();

    const state = {
      folder,
      scenarios: scenariosData.scenarios,
      selected: new Set(),
      results: {},
      // steps[scenarioName][stepName] = { status, duration }
      // Populated live from step-start/step-pass/step-fail SSE events.
      steps: {},
      search: "",
      activeResultName: null,
      hasRun: false,
      collapsed: false,
      el: {},
    };
    folderStates[folder.id] = state;

    // ---- Section header (VS Code style: chevron + icon + name + count) ----
    const header = document.createElement("div");
    header.className = "folder-section-header";

    const chevron = document.createElement("span");
    chevron.className = "folder-chevron";
    chevron.textContent = "▾";
    header.appendChild(chevron);

    const icon = document.createElement("span");
    icon.className = "folder-section-icon";
    icon.textContent = folder.icon;
    header.appendChild(icon);

    const name = document.createElement("span");
    name.className = "folder-section-name";
    name.textContent = folder.displayName;
    header.appendChild(name);

    const count = document.createElement("span");
    count.className = "folder-section-count";
    count.textContent = String(state.scenarios.length);
    header.appendChild(count);

    header.addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      chevron.classList.toggle("collapsed", state.collapsed);
      body.classList.toggle("collapsed", state.collapsed);
    });

    // ---- Section body (search + select-all + scenario list, this folder's own) ----
    const body = document.createElement("div");
    body.className = "folder-section-body";

    const controls = document.createElement("div");
    controls.className = "left-controls";

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "search-input";
    searchInput.placeholder = "Search scenarios...";
    searchInput.addEventListener("input", () => {
      state.search = searchInput.value;
      currentFolderId = folder.id;
      renderFolderScenarioList(folder.id);
    });
    controls.appendChild(searchInput);

    const selectAllLabel = document.createElement("label");
    selectAllLabel.className = "select-all-label";
    const selectAllCheckbox = document.createElement("input");
    selectAllCheckbox.type = "checkbox";
    selectAllLabel.appendChild(selectAllCheckbox);
    selectAllLabel.appendChild(document.createTextNode(" Select all ("));
    const totalCountEl = document.createElement("span");
    totalCountEl.textContent = String(state.scenarios.length);
    selectAllLabel.appendChild(totalCountEl);
    selectAllLabel.appendChild(document.createTextNode(")"));
    selectAllCheckbox.addEventListener("change", () => {
      currentFolderId = folder.id;
      state.selected = selectAllCheckbox.checked ? new Set(state.scenarios.map((sc) => sc.name)) : new Set();
      renderFolderScenarioList(folder.id);
      renderCenterList();
      updateButtonStates();
    });
    controls.appendChild(selectAllLabel);

    body.appendChild(controls);

    const scenarioListEl = document.createElement("div");
    scenarioListEl.className = "scenario-list";
    body.appendChild(scenarioListEl);

    state.el = { scenarioListEl, searchInputEl: searchInput, selectAllCheckboxEl: selectAllCheckbox, totalCountEl, sectionBodyEl: body, chevronEl: chevron };

    folderTreeEl.appendChild(header);
    folderTreeEl.appendChild(body);

    renderFolderScenarioList(folder.id);
  }

  async function checkConfig() {
    const res = await fetch("/api/config-status");
    const data = await res.json();
    configOk = data.ok;
    if (data.ok) {
      configWarning.classList.add("hidden");
    } else {
      configErrors.innerHTML = "";
      for (const err of data.errors) {
        const li = document.createElement("li");
        li.textContent = err;
        configErrors.appendChild(li);
      }
      configWarning.classList.remove("hidden");
    }
    updateButtonStates();
  }

  // ---------- Rendering: a folder's own scenario list ----------
  function renderFolderScenarioList(folderId) {
    const state = folderStates[folderId];
    const filtered = state.scenarios.filter((sc) => {
      if (!state.search) return true;
      const q = state.search.toLowerCase();
      return sc.name.toLowerCase().includes(q) || sc.category.toLowerCase().includes(q);
    });

    state.el.scenarioListEl.innerHTML = "";
    for (const sc of filtered) {
      state.el.scenarioListEl.appendChild(buildLeftRow(folderId, sc));
    }

    state.el.selectAllCheckboxEl.checked = state.scenarios.length > 0 && state.scenarios.every((sc) => state.selected.has(sc.name));
  }

  function buildLeftRow(folderId, sc) {
    const state = folderStates[folderId];
    const row = document.createElement("div");
    row.className = "scenario-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(sc.name);
    checkbox.addEventListener("change", () => {
      currentFolderId = folderId;
      if (checkbox.checked) state.selected.add(sc.name);
      else state.selected.delete(sc.name);
      renderFolderScenarioList(folderId);
      renderCenterList();
      updateButtonStates();
    });
    row.appendChild(checkbox);

    const info = document.createElement("div");
    info.className = "scenario-info";
    const nameEl = document.createElement("span");
    nameEl.className = "scenario-name";
    nameEl.textContent = sc.name;
    const subEl = document.createElement("span");
    subEl.className = "scenario-sub";
    subEl.textContent = `${sc.steps.length} steps · ${sc.category}`;
    info.appendChild(nameEl);
    info.appendChild(subEl);
    row.appendChild(info);

    const dot = document.createElement("span");
    const r = state.results[sc.name];
    dot.className = "status-dot" + (r ? ` ${r.status}` : "");
    row.appendChild(dot);

    return row;
  }

  // ---------- Rendering: center pane ----------
  function renderCenterList() {
    const state = currentState();
    if (!state) {
      resultsListEl.classList.add("hidden");
      emptyNoSelectionEl.classList.remove("hidden");
      badgesEl.classList.add("hidden");
      clearBtn.classList.add("hidden");
      return;
    }

    const selectedScenarios = state.scenarios.filter((sc) => state.selected.has(sc.name));

    if (selectedScenarios.length === 0) {
      resultsListEl.classList.add("hidden");
      emptyNoSelectionEl.classList.remove("hidden");
      badgesEl.classList.add("hidden");
      clearBtn.classList.add("hidden");
      return;
    }

    emptyNoSelectionEl.classList.add("hidden");
    resultsListEl.classList.remove("hidden");
    resultsListEl.innerHTML = "";

    for (const sc of selectedScenarios) {
      resultsListEl.appendChild(buildResultRow(sc));
    }

    updateBadges(selectedScenarios);
  }

  function buildResultRow(sc) {
    const state = currentState();
    const row = document.createElement("div");
    const r = state.results[sc.name];
    row.className = "result-row";
    if (state.activeResultName === sc.name) row.classList.add("active");
    if (r && r.status === "fail") row.classList.add("fail-border");

    row.addEventListener("click", () => {
      state.activeResultName = sc.name;
      renderCenterList();
      renderRightPanel();
    });

    if (r && r.status === "running") {
      const spinner = document.createElement("span");
      spinner.className = "spinner-md";
      row.appendChild(spinner);
    } else if (r && (r.status === "pass" || r.status === "fail")) {
      const icon = document.createElement("span");
      icon.className = `result-icon ${r.status}`;
      icon.textContent = r.status === "pass" ? "✓" : "✕";
      row.appendChild(icon);
    } else {
      const dot = document.createElement("span");
      dot.className = "result-pending-dot";
      row.appendChild(dot);
    }

    const info = document.createElement("div");
    info.className = "result-info";
    const nameEl = document.createElement("span");
    nameEl.className = "result-name";
    nameEl.textContent = sc.name;
    const subEl = document.createElement("span");
    subEl.className = "result-sub";
    subEl.textContent = `${sc.steps.length} steps · ${sc.category}`;
    info.appendChild(nameEl);
    info.appendChild(subEl);
    row.appendChild(info);

    if (r && (r.status === "pass" || r.status === "fail") && typeof r.duration === "number") {
      const dur = document.createElement("span");
      dur.className = "result-duration";
      dur.textContent = `${r.duration}ms`;
      row.appendChild(dur);
    }

    return row;
  }

  function updateBadges(selectedScenarios) {
    const state = currentState();
    if (!state || !state.hasRun) {
      badgesEl.classList.add("hidden");
      clearBtn.classList.add("hidden");
      return;
    }
    let pass = 0;
    let fail = 0;
    let pending = 0;
    for (const sc of selectedScenarios) {
      const r = state.results[sc.name];
      if (r && r.status === "pass") pass++;
      else if (r && r.status === "fail") fail++;
      else pending++;
    }
    badgesEl.classList.remove("hidden");
    clearBtn.classList.remove("hidden");
    passCountEl.textContent = String(pass);
    failCountEl.textContent = String(fail);
    pendingCountEl.textContent = String(pending);
    badgeFailEl.classList.toggle("hidden", fail === 0);
    badgePendingEl.classList.toggle("hidden", pending === 0);
  }

  // ---------- Rendering: right pane ----------
  function renderRightPanel() {
    const state = currentState();
    if (!state || !state.activeResultName) {
      detailEmptyEl.classList.remove("hidden");
      detailContentEl.classList.add("hidden");
      return;
    }
    const sc = state.scenarios.find((s) => s.name === state.activeResultName);
    const r = state.results[state.activeResultName];
    if (!sc) return;

    detailEmptyEl.classList.add("hidden");
    detailContentEl.classList.remove("hidden");

    detailNameEl.textContent = sc.name;
    detailBodyEl.innerHTML = "";

    // Steps are a static, informational list (from meta.js) - not run
    // individually, not tracked pass/fail per step. Always shown regardless
    // of run state, since "what does this scenario check" is useful to know
    // whether or not it's been run yet.
    appendStepsSection(sc);

    if (!r) {
      detailStatusBadgeEl.textContent = "";
      detailStatusBadgeEl.className = "status-badge hidden";
      detailDurationEl.textContent = "";
      const p = document.createElement("p");
      p.className = "detail-pass-message";
      p.style.color = "var(--text-mutedmore)";
      p.textContent = "Not run yet.";
      detailBodyEl.appendChild(p);
      return;
    }

    if (r.status === "running") {
      detailStatusBadgeEl.textContent = "Running";
      detailStatusBadgeEl.className = "status-badge";
      detailStatusBadgeEl.style.background = "var(--pending-bg)";
      detailStatusBadgeEl.style.color = "var(--pending-fg)";
      detailDurationEl.textContent = "";
      const p = document.createElement("p");
      p.className = "detail-pass-message";
      p.style.color = "var(--text-mutedmore)";
      p.textContent = "Test is running…";
      detailBodyEl.appendChild(p);
      return;
    }

    detailStatusBadgeEl.className = `status-badge ${r.status}`;
    detailStatusBadgeEl.style.background = "";
    detailStatusBadgeEl.style.color = "";
    detailStatusBadgeEl.textContent = r.status === "pass" ? "Passed" : "Failed";
    detailDurationEl.textContent = typeof r.duration === "number" ? `${r.duration}ms` : "";

    if (r.status === "pass") {
      const resultHeading = document.createElement("span");
      resultHeading.className = "detail-section-heading";
      resultHeading.textContent = "Result";
      detailBodyEl.appendChild(resultHeading);
      const p = document.createElement("p");
      p.className = "detail-pass-message";
      p.textContent = "All checks in this scenario passed.";
      detailBodyEl.appendChild(p);
    } else {
      // Per-step request/response detail isn't captured yet (see README /
      // conversation) - showing the real failure message(s) Jest reported,
      // which already includes which internal step failed (e.g. "[list
      // tables and check core tables present] Expected ...").
      const failureHeading = document.createElement("span");
      failureHeading.className = "detail-section-heading";
      failureHeading.textContent = "Error";
      detailBodyEl.appendChild(failureHeading);
      for (const msg of r.failureMessages || []) {
        const pre = document.createElement("pre");
        pre.textContent = msg;
        detailBodyEl.appendChild(pre);
      }
    }
  }

  /**
   * Appends the "Steps" list to the right panel.
   *
   * The step NAMES come from meta.js (so they're visible before a run ever
   * happens), but each step's live status comes from the real run: helpers/
   * step.js POSTs start/pass/fail events to the server, which re-emits them
   * onto the same SSE stream as the test results. Steps are matched by name.
   *
   * A name present in meta.js but never reported just stays "pending", which
   * is also how a stale meta.js shows up visually - worth knowing, since that
   * file has drifted before.
   */
  function appendStepsSection(sc) {
    const state = currentState();
    const liveSteps = (state && state.steps && state.steps[sc.name]) || {};
    const doneCount = Object.values(liveSteps).filter((s) => s.status === "pass" || s.status === "fail").length;

    const heading = document.createElement("span");
    heading.className = "detail-section-heading";
    heading.textContent = doneCount > 0 ? `Steps (${doneCount}/${sc.steps.length})` : `Steps (${sc.steps.length})`;
    detailBodyEl.appendChild(heading);

    const list = document.createElement("ol");
    list.className = "steps-list";
    for (const stepName of sc.steps) {
      const li = document.createElement("li");
      const live = liveSteps[stepName];
      const status = live ? live.status : "pending";
      li.className = `step-item step-${status}`;

      const icon = document.createElement("span");
      icon.className = `step-icon step-icon-${status}`;
      icon.textContent = status === "pass" ? "✓" : status === "fail" ? "✕" : status === "running" ? "◍" : "○";
      li.appendChild(icon);

      const label = document.createElement("span");
      label.className = "step-label";
      label.textContent = stepName;
      li.appendChild(label);

      if (live && typeof live.duration === "number") {
        const dur = document.createElement("span");
        dur.className = "step-duration";
        dur.textContent = `${live.duration}ms`;
        li.appendChild(dur);
      }
      list.appendChild(li);
    }
    detailBodyEl.appendChild(list);
  }

  // ---------- Buttons ----------
  function updateButtonStates() {
    const state = currentState();
    const selectedCount = state ? state.selected.size : 0;
    runAllBtn.disabled = isRunning || !configOk || !state;
    runSelectedBtn.disabled = isRunning || !configOk || selectedCount === 0;
    runSelectedLabel.textContent = isRunning ? "Running…" : `Run Selected (${selectedCount})`;
    runSpinner.classList.toggle("hidden", !isRunning);
  }

  function runTests(namesFilter) {
    const state = currentState();
    if (!state) return;

    isRunning = true;
    state.hasRun = true;
    updateButtonStates();

    const targetNames = namesFilter || state.scenarios.map((sc) => sc.name);
    for (const name of targetNames) {
      state.results[name] = { status: "running" };
      state.steps[name] = {}; // drop any step state from a previous run
    }
    renderFolderScenarioList(state.folder.id);
    renderCenterList();
    if (state.activeResultName) renderRightPanel();

    let url = `/api/run-stream?folder=${encodeURIComponent(state.folder.id)}`;
    if (namesFilter) {
      url += `&names=${encodeURIComponent(namesFilter.join(","))}`;
    }

    const source = new EventSource(url);

    source.onmessage = (evt) => {
      const event = JSON.parse(evt.data);

      if (event.type === "step-start" || event.type === "step-pass" || event.type === "step-fail") {
        // Live per-step updates. `scenario` is attached by helpers/
        // stepReporter.js via AsyncLocalStorage, which is what keeps the four
        // concurrent tests in connector.test.js from mixing up their steps.
        if (event.scenario) {
          if (!state.steps[event.scenario]) state.steps[event.scenario] = {};
          state.steps[event.scenario][event.name] = {
            status: event.type === "step-start" ? "running" : event.type === "step-pass" ? "pass" : "fail",
            duration: event.duration,
            message: event.message,
          };
          if (state.activeResultName === event.scenario) renderRightPanel();
        }
        return;
      }

      if (event.type === "result") {
        state.results[event.name] = {
          status: event.status === "PASS" ? "pass" : "fail",
          duration: event.duration,
          failureMessages: event.failureMessages,
        };
        renderFolderScenarioList(state.folder.id);
        renderCenterList();
        if (state.activeResultName === event.name) renderRightPanel();
      } else if (event.type === "done") {
        finishRun();
        source.close();
      } else if (event.type === "fatal") {
        alert(`Test run failed unexpectedly: ${event.message}`);
        finishRun();
        source.close();
      }
    };

    source.onerror = () => {
      finishRun();
      source.close();
    };
  }

  let finished = false;
  function finishRun() {
    if (finished) return;
    finished = true;
    isRunning = false;
    updateButtonStates();
    renderCenterList();
  }

  runAllBtn.addEventListener("click", () => {
    if (isRunning) return;
    const state = currentState();
    if (!state) return;
    state.selected = new Set(state.scenarios.map((sc) => sc.name));
    renderFolderScenarioList(state.folder.id);
    finished = false;
    runTests(null); // no filter = run everything in this folder
  });

  runSelectedBtn.addEventListener("click", () => {
    const state = currentState();
    if (isRunning || !state || state.selected.size === 0) return;
    finished = false;
    runTests(Array.from(state.selected));
  });

  clearBtn.addEventListener("click", () => {
    const state = currentState();
    if (!state) return;
    state.results = {};
    state.steps = {};
    state.hasRun = false;
    state.activeResultName = null;
    renderFolderScenarioList(state.folder.id);
    renderCenterList();
    renderRightPanel();
  });

  (async function init() {
    await loadFolders();
    await checkConfig();
  })();
})();
