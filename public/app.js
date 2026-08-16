(() => {
  "use strict";

  // ---------- DOM refs: views ----------
  const viewHomeEl = document.getElementById("view-home");
  const viewProjectEl = document.getElementById("view-project");
  const viewRunnerEl = document.getElementById("view-runner");

  const homeLoadingEl = document.getElementById("home-loading");

  const connectFormEl = document.getElementById("connect-form");
  const apiKeyInputEl = document.getElementById("api-key-input");
  const toggleKeyVisibilityBtn = document.getElementById("toggle-key-visibility");
  const connectBtn = document.getElementById("connect-btn");
  const connectErrorEl = document.getElementById("connect-error");

  const projectIdFormEl = document.getElementById("project-id-form");
  const projectIdInputEl = document.getElementById("project-id-input");
  const connectProjectBtn = document.getElementById("connect-project-btn");
  const connectProjectErrorEl = document.getElementById("connect-project-error");

  const homeConnectedEl = document.getElementById("home-connected");
  const connectedLabelEl = document.getElementById("connected-label");
  const disconnectBtn = document.getElementById("disconnect-btn");
  const homeSwitchAccountBtn = document.getElementById("home-switch-account-btn");
  const projectGridEl = document.getElementById("project-grid");
  const homeEmptyEl = document.getElementById("home-empty");

  const breadcrumbHomeBtn = document.getElementById("breadcrumb-home");
  const breadcrumbProjectEl = document.getElementById("breadcrumb-project");
  const projectTitleEl = document.getElementById("project-title");
  const projectLoadingEl = document.getElementById("project-loading");
  const projectErrorEl = document.getElementById("project-error");
  const connectorGridEl = document.getElementById("connector-grid");
  const projectEmptyEl = document.getElementById("project-empty");
  const projectBackBtn = document.getElementById("project-back-btn");
  const projectSwitchAccountBtn = document.getElementById("project-switch-account-btn");

  // Project-view batch controls - several connectors at once, which is what
  // the concurrent backend exists for.
  const projectRunSelectedBtn = document.getElementById("project-run-selected-btn");
  const projectRunSelectedLabel = document.getElementById("project-run-selected-label");
  const projectStopAllBtn = document.getElementById("project-stop-all-btn");
  const projectRunningNoteEl = document.getElementById("project-running-note");

  // folderId -> { card, status, track, fill, connector } for the cards
  // currently on screen, so a run can repaint just its own card. Rebuilt
  // whenever the project view renders.
  const connectorCards = new Map();
  // Which connectors are ticked for the next batch run.
  const selectedConnectorIds = new Set();

  const breadcrumbRunnerHomeBtn = document.getElementById("breadcrumb-runner-home");
  const breadcrumbRunnerProjectBtn = document.getElementById("breadcrumb-runner-project");
  const breadcrumbRunnerConnectorEl = document.getElementById("breadcrumb-runner-connector");
  const runnerBackBtn = document.getElementById("runner-back-btn");
  const runnerSwitchAccountBtn = document.getElementById("runner-switch-account-btn");

  // Icon shown on a connector card when it has no matching tests/<type>/
  // folder yet (e.g. MongoDB, Postgres, Google Ads) - meta.js's own icon
  // (via /api/peaka/projects/:id/connectors) wins whenever one exists.
  const FALLBACK_CONNECTOR_ICON = "🔌";

  // Which Peaka project + connection the runner view is currently scoped to
  // - threaded into every /api/config-status and /api/run-stream call so the
  // server resolves catalog/schema dynamically instead of from .env. See
  // server.js's applyDynamicConnectorConfig().
  let selectedProject = null; // { id, name }
  let selectedConnector = null; // { connectionId, folderId, displayName, icon }

  function showView(name) {
    viewHomeEl.classList.toggle("hidden", name !== "home");
    viewProjectEl.classList.toggle("hidden", name !== "project");
    viewRunnerEl.classList.toggle("hidden", name !== "runner");
  }

  function hideAllHomeCards() {
    connectFormEl.classList.add("hidden");
    projectIdFormEl.classList.add("hidden");
    homeConnectedEl.classList.add("hidden");
  }

  /**
   * The home screen: connect with a Partner API key, resolve a project (if
   * the key can only see one - see server.js's classifyApiKey), then pick a
   * project. Always does a fresh /api/peaka/session check rather than
   * trusting client-side state, since the server is the source of truth for
   * whether a key/project is still valid.
   */
  async function showHome() {
    selectedProject = null;
    selectedConnector = null;
    showView("home");
    homeLoadingEl.classList.remove("hidden");
    hideAllHomeCards();

    let data;
    try {
      const res = await fetch("/api/peaka/session");
      data = await res.json();
    } catch (err) {
      data = { ok: false, connected: false, error: err.message };
    }

    homeLoadingEl.classList.add("hidden");
    renderHome(data);
  }

  function renderHome(data) {
    hideAllHomeCards();
    homeSwitchAccountBtn.classList.toggle("hidden", !data.connected);

    if (!data.connected) {
      connectFormEl.classList.remove("hidden");
      if (data.error) {
        connectErrorEl.textContent = data.error;
        connectErrorEl.classList.remove("hidden");
      } else {
        connectErrorEl.classList.add("hidden");
      }
      apiKeyInputEl.focus();
      return;
    }

    if (data.mode === "scoped-needs-project") {
      projectIdFormEl.classList.remove("hidden");
      projectIdInputEl.focus();
      return;
    }

    // mode "multi" (several projects) or "single" (exactly one, already
    // resolved) - both render as the same project grid, just with a
    // different project count.
    const projects = data.mode === "single" ? [data.project] : data.projects;
    homeConnectedEl.classList.remove("hidden");
    connectedLabelEl.textContent =
      projects.length === 1 && data.mode === "single" ? "Connected to 1 project" : `Connected · ${projects.length} project${projects.length === 1 ? "" : "s"}`;

    if (projects.length === 0) {
      homeEmptyEl.classList.remove("hidden");
      projectGridEl.classList.add("hidden");
      return;
    }

    homeEmptyEl.classList.add("hidden");
    projectGridEl.innerHTML = "";
    for (const project of projects) {
      projectGridEl.appendChild(buildProjectCard(project));
    }
    projectGridEl.classList.remove("hidden");
  }

  connectFormEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const apiKey = apiKeyInputEl.value.trim();
    if (!apiKey) return;
    connectBtn.disabled = true;
    connectErrorEl.classList.add("hidden");
    let data;
    try {
      const res = await fetch("/api/peaka/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      data = await res.json();
    } catch (err) {
      data = { ok: false, error: err.message };
    }
    connectBtn.disabled = false;
    if (!data.ok) {
      connectErrorEl.textContent = data.error;
      connectErrorEl.classList.remove("hidden");
      return;
    }
    apiKeyInputEl.value = "";
    await showHome();
  });

  toggleKeyVisibilityBtn.addEventListener("click", () => {
    apiKeyInputEl.type = apiKeyInputEl.type === "password" ? "text" : "password";
  });

  projectIdFormEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const projectId = projectIdInputEl.value.trim();
    if (!projectId) return;
    connectProjectBtn.disabled = true;
    connectProjectErrorEl.classList.add("hidden");
    let data;
    try {
      const res = await fetch("/api/peaka/connect-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      data = await res.json();
    } catch (err) {
      data = { ok: false, error: err.message };
    }
    connectProjectBtn.disabled = false;
    if (!data.ok) {
      connectProjectErrorEl.textContent = data.error;
      connectProjectErrorEl.classList.remove("hidden");
      return;
    }
    await showHome();
  });

  // Shared by every "switch account" entry point (the home view's connected
  // bar, and the always-visible topbar buttons on the project/runner views)
  // so a second person can hand off to their own key from wherever the first
  // person left off, without hunting for a specific screen first.
  async function disconnectAndGoHome() {
    await fetch("/api/peaka/disconnect", { method: "POST" });
    await showHome();
  }
  disconnectBtn.addEventListener("click", disconnectAndGoHome);
  homeSwitchAccountBtn.addEventListener("click", disconnectAndGoHome);
  projectSwitchAccountBtn.addEventListener("click", disconnectAndGoHome);
  runnerSwitchAccountBtn.addEventListener("click", disconnectAndGoHome);

  projectBackBtn.addEventListener("click", showHome);
  runnerBackBtn.addEventListener("click", () => selectedProject && showProject(selectedProject));

  function buildProjectCard(project) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card project-card";

    const icon = document.createElement("span");
    icon.className = "card-icon";
    icon.textContent = "📁";
    card.appendChild(icon);

    const info = document.createElement("div");
    info.className = "card-info";
    const name = document.createElement("span");
    name.className = "card-title";
    name.textContent = project.name;
    info.appendChild(name);
    if (project.workspaceName) {
      const sub = document.createElement("span");
      sub.className = "card-sub";
      sub.textContent = project.workspaceName;
      info.appendChild(sub);
    }
    card.appendChild(info);

    card.addEventListener("click", () => showProject(project));
    return card;
  }

  async function showProject(project) {
    selectedProject = project;
    selectedConnector = null;
    showView("project");
    projectTitleEl.textContent = project.name;
    breadcrumbProjectEl.textContent = project.name;
    projectLoadingEl.classList.remove("hidden");
    projectErrorEl.classList.add("hidden");
    connectorGridEl.classList.add("hidden");
    projectEmptyEl.classList.add("hidden");

    let data;
    try {
      const res = await fetch(`/api/peaka/projects/${encodeURIComponent(project.id)}/connectors`);
      data = await res.json();
    } catch (err) {
      data = { ok: false, error: err.message };
    }

    projectLoadingEl.classList.add("hidden");
    if (!data.ok) {
      projectErrorEl.textContent = data.error;
      projectErrorEl.classList.remove("hidden");
      return;
    }
    if (data.connectors.length === 0) {
      projectEmptyEl.classList.remove("hidden");
      return;
    }

    connectorGridEl.innerHTML = "";
    connectorCards.clear();
    exclusiveFolders.clear();

    // Companions (the race folders) render immediately after the connector
    // they exercise rather than in list order, so "Concurrency Races" reads
    // as a mode of Stripe rather than a peer of it.
    const primaries = data.connectors.filter((c) => !c.companionOf);
    const ordered = [];
    for (const primary of primaries) {
      ordered.push(primary);
      for (const c of data.connectors) {
        if (c.companionOf && c.companionOf === primary.folderId) ordered.push(c);
      }
    }
    // Anything whose parent is not in this project still gets shown rather
    // than silently dropped.
    for (const c of data.connectors) if (!ordered.includes(c)) ordered.push(c);

    for (const connector of ordered) {
      if (connector.exclusive && connector.folderId) exclusiveFolders.add(connector.folderId);
      connectorGridEl.appendChild(buildConnectorCard(project, connector));
    }
    connectorGridEl.classList.remove("hidden");

    // Scenario lists for every runnable connector, so a batch can start
    // without a round trip per card and the cards can show totals.
    await Promise.all(
      ordered.filter((c) => c.hasTests).map((c) => ensureFolderState({
        id: c.folderId,
        displayName: c.displayName,
        icon: c.icon,
        scenarioCount: c.scenarioCount,
      }))
    );

    // Resync against the server so the cards reflect runs this page did not
    // start itself.
    //
    // Measured, so nobody expects more of it than it gives: this does NOT
    // survive a reload. server.js kills a run's child when its EventSource
    // disconnects (req.on("close"), deliberately - see its comment about not
    // burning API calls for a run nobody is watching), so by the time a
    // reloaded page asks, the run it would have resumed is already gone. What
    // this does cover is a SECOND tab, or a run launched outside this page.
    try {
      const activeRes = await fetch("/api/active-runs");
      const active = await activeRes.json();
      for (const id of active.running || []) {
        if (folderStates[id]) folderStates[id].isRunning = true;
      }
    } catch (_) {
      // Cosmetic resync only - never worth blocking the view over.
    }

    updateProjectRunControls();
  }

  /**
   * One connector card.
   *
   * A <div> rather than the <button> this used to be: it now holds a checkbox
   * for multi-select, and nesting a control inside a button is invalid and
   * breaks keyboard behaviour. The navigation affordance moved to an inner
   * button covering everything except the checkbox.
   */
  function buildConnectorCard(project, connector) {
    const card = document.createElement("div");
    card.className = "card connector-card" + (connector.hasTests ? "" : " card-disabled");
    if (connector.companionOf) card.classList.add("connector-card-companion");
    card.dataset.folderId = connector.folderId || "";

    if (connector.hasTests) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "connector-check";
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedConnectorIds.add(connector.folderId);
        else selectedConnectorIds.delete(connector.folderId);
        updateProjectRunControls();
      });
      card.appendChild(checkbox);
    }

    // Everything but the checkbox navigates into the runner. Deliberately
    // still live during a run: folderStates persists, so the runner shows
    // that folder's scenarios streaming in real time.
    const open = document.createElement("button");
    open.type = "button";
    open.className = "connector-open";
    open.disabled = !connector.hasTests;

    const icon = document.createElement("span");
    icon.className = "card-icon";
    icon.textContent = connector.icon || FALLBACK_CONNECTOR_ICON;
    open.appendChild(icon);

    const info = document.createElement("div");
    info.className = "card-info";
    const name = document.createElement("span");
    name.className = "card-title";
    name.textContent = connector.name;
    info.appendChild(name);

    const sub = document.createElement("span");
    sub.className = "card-sub";
    sub.textContent = connector.hasTests ? `${connector.scenarioCount} scenarios` : "No test suite yet";
    info.appendChild(sub);

    if (connector.exclusive) {
      const note = document.createElement("span");
      note.className = "card-note";
      note.textContent = "runs alone — blocks every other connector";
      info.appendChild(note);
    }

    // Live status, filled by refreshCardFor() from this folder's own state.
    const status = document.createElement("span");
    status.className = "card-status hidden";
    info.appendChild(status);

    const track = document.createElement("div");
    track.className = "step-progress-track hidden";
    const fill = document.createElement("div");
    fill.className = "step-progress-fill";
    track.appendChild(fill);
    info.appendChild(track);

    open.appendChild(info);
    card.appendChild(open);

    if (connector.hasTests) {
      open.addEventListener("click", () => showRunner(project, connector));
      connectorCards.set(connector.folderId, { card, status, track, fill, connector });
    }
    return card;
  }

  /**
   * Repaints one card's live status from folderStates. Called on every step
   * and result event, and cheap enough to do so - it touches three nodes.
   */
  function refreshCardFor(folderId) {
    const entry = connectorCards.get(folderId);
    const state = folderStates[folderId];
    if (!entry || !state) return;

    const total = state.scenarios.length;
    let pass = 0;
    let fail = 0;
    let skipped = 0;
    let done = 0;
    for (const sc of state.scenarios) {
      const status = scenarioStatus(state, sc.name);
      if (!status || status === "running") continue;
      done++;
      if (status === "pass" || status === "warn") pass++;
      else if (status === "fail") fail++;
      else if (status === "skipped") skipped++;
    }

    if (!state.hasRun) {
      entry.status.classList.add("hidden");
      entry.track.classList.add("hidden");
      return;
    }

    const parts = [];
    if (pass) parts.push(`${pass} passed`);
    if (fail) parts.push(`${fail} failed`);
    if (skipped) parts.push(`${skipped} skipped`);
    entry.status.textContent = state.isRunning
      ? `running — ${done}/${total}${parts.length ? " · " + parts.join(" · ") : ""}`
      : parts.join(" · ") || "no results";
    entry.status.classList.remove("hidden");
    entry.status.classList.toggle("card-status-running", state.isRunning);
    entry.status.classList.toggle("card-status-fail", !state.isRunning && fail > 0);

    entry.track.classList.remove("hidden");
    entry.fill.classList.toggle("failed", fail > 0);
    entry.fill.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
  }

  /**
   * The project view's Run/Stop controls and every checkbox's enabled state.
   *
   * Exclusivity is enforced here rather than only on the server: ticking the
   * races folder disables the rest and vice versa, so the rule is visible
   * before clicking Run instead of arriving as a 409 afterwards.
   */
  function updateProjectRunControls() {
    if (!projectRunSelectedBtn) return;

    const exclusivePicked = [...selectedConnectorIds].some((id) => isExclusiveFolder(id));
    const anyNonExclusivePicked = [...selectedConnectorIds].some((id) => !isExclusiveFolder(id));

    for (const [folderId, entry] of connectorCards) {
      const checkbox = entry.card.querySelector(".connector-check");
      if (!checkbox) continue;
      checkbox.checked = selectedConnectorIds.has(folderId);
      const blockedByExclusive = isExclusiveFolder(folderId)
        ? anyNonExclusivePicked
        : exclusivePicked;
      checkbox.disabled = blockedByExclusive || !canStartClientSide(folderId);
      entry.card.classList.toggle("card-blocked", checkbox.disabled && !checkbox.checked);
      refreshCardFor(folderId);
    }

    const count = selectedConnectorIds.size;
    const startable = [...selectedConnectorIds].filter((id) => canStartClientSide(id));
    projectRunSelectedBtn.disabled = startable.length === 0;
    projectRunSelectedLabel.textContent = `Run selected (${count})`;

    const running = runningFolderIds().length;
    projectStopAllBtn.classList.toggle("hidden", running === 0);
    projectRunningNoteEl.classList.toggle("hidden", running === 0);
    projectRunningNoteEl.textContent = running === 1 ? "1 connector running" : `${running} connectors running`;
  }

  async function showRunner(project, connector) {
    selectedProject = project;
    selectedConnector = connector;
    showView("runner");

    breadcrumbRunnerProjectBtn.textContent = project.name;
    breadcrumbRunnerConnectorEl.textContent = connector.displayName;

    // Only the left pane's DOM is rebuilt for whichever connector was picked.
    // folderStates is deliberately NOT reset: a batch run started from the
    // project view records results for several folders at once, and clearing
    // here would wipe exactly the detail this click is asking to see. Stale
    // node references in each state's `el` are replaced by addFolderSection().
    folderTreeEl.innerHTML = "";
    currentFolderId = null;

    const folderRes = await fetch("/api/folders");
    const folderData = await folderRes.json();
    const folder = folderData.folders.find((f) => f.id === connector.folderId);
    if (!folder) return; // shouldn't happen - hasTests already confirmed this folder exists

    await addFolderSection(folder);
    currentFolderId = folder.id;
    renderCenterList();
    renderRightPanel();
    updateButtonStates();
    await checkConfig(folder.id);
  }

  breadcrumbHomeBtn.addEventListener("click", showHome);
  breadcrumbRunnerHomeBtn.addEventListener("click", showHome);
  breadcrumbRunnerProjectBtn.addEventListener("click", () => selectedProject && showProject(selectedProject));

  // ---------- DOM refs (things that exist once, regardless of folder count) ----------
  const folderTreeEl = document.getElementById("folder-tree");

  const runAllBtn = document.getElementById("run-all-btn");
  const runSelectedBtn = document.getElementById("run-selected-btn");
  const runSpinner = document.getElementById("run-spinner");
  const runSelectedLabel = document.getElementById("run-selected-label");
  const stopRunBtn = document.getElementById("stop-run-btn");

  const configWarning = document.getElementById("config-warning");
  const configErrors = document.getElementById("config-errors");

  const badgesEl = document.getElementById("badges");
  const passCountEl = document.getElementById("pass-count");
  const badgeFailEl = document.getElementById("badge-fail");
  const failCountEl = document.getElementById("fail-count");
  const badgeStoppedEl = document.getElementById("badge-stopped");
  const stoppedCountEl = document.getElementById("stopped-count");
  const badgePendingEl = document.getElementById("badge-pending");
  const pendingCountEl = document.getElementById("pending-count");
  const badgeWarnEl = document.getElementById("badge-warn");
  const warnCountEl = document.getElementById("warn-count");
  const badgeSkippedEl = document.getElementById("badge-skipped");
  const skippedCountEl = document.getElementById("skipped-count");
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
  //
  // PERSISTS ACROSS VIEW SWITCHES. showRunner() used to reset this on every
  // entry, which was fine while the runner was the only thing that could run
  // tests. Now a batch started from the project view writes results here for
  // several folders at once, and wiping on entry would destroy exactly the
  // detail you clicked in to see. `el` is the one part that does NOT survive:
  // the runner rebuilds its own markup, so those node references go stale and
  // are replaced per entry - see addFolderSection().
  let folderStates = {};

  // Which folder the runner view is currently DISPLAYING. Purely a view
  // concern now: runs are keyed by folder id and proceed regardless of what
  // is on screen, so this only decides which panes get repainted.
  let currentFolderId = null;

  let configOk = false;

  function currentState() {
    return currentFolderId ? folderStates[currentFolderId] : null;
  }

  /** Folders with a run in flight right now. */
  function runningFolderIds() {
    return Object.keys(folderStates).filter((id) => folderStates[id].isRunning);
  }

  /**
   * Mirrors server.js's canStart() so a button disables instead of the user
   * clicking and getting a 409 back. `exclusive` comes from the server on the
   * connector list (race folders, see tests/races/config.js's racesFor) -
   * deliberately not re-derived here, so there is one source of truth.
   */
  function canStartClientSide(folderId) {
    const state = folderStates[folderId];
    if (state && state.isRunning) return false;
    const running = runningFolderIds();
    if (isExclusiveFolder(folderId)) return running.length === 0;
    return !running.some((id) => isExclusiveFolder(id));
  }

  // folderId -> true for folders the server reports as needing exclusive
  // access. Populated from the connector list in showProject().
  const exclusiveFolders = new Set();
  function isExclusiveFolder(folderId) {
    return exclusiveFolders.has(folderId);
  }

  // ---------- Data loading ----------
  // Builds the left-pane section for ONE folder (the connector picked in
  // showRunner()) - the dashboard now only ever shows a single connector's
  // scenarios at a time, scoped to the project+connection chosen upstream.
  /**
   * Creates a folder's run-state if it has none yet, and returns it.
   *
   * Split out from addFolderSection() because the project view needs to start
   * a run for a folder WITHOUT building the runner's left-pane DOM for it -
   * a batch can cover five connectors while the runner shows none of them.
   * Idempotent: an existing state is returned untouched, which is what lets
   * results survive navigating in and out of the runner.
   */
  async function ensureFolderState(folder) {
    if (folderStates[folder.id]) return folderStates[folder.id];

    const scenariosRes = await fetch(`/api/scenarios?folder=${encodeURIComponent(folder.id)}`);
    const scenariosData = await scenariosRes.json();
    folderStates[folder.id] = {
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
      isRunning: false,
      el: {},
    };
    return folderStates[folder.id];
  }

  async function addFolderSection(folder) {
    // Reuses existing data when there is any - a batch run started from the
    // project view may already have populated results and steps for this
    // folder, and rebuilding would throw them away. Only `el` is replaced
    // below, since the runner tears its own markup out on every entry.
    const state = await ensureFolderState(folder);

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
      if (currentFolderId !== folder.id) {
        currentFolderId = folder.id;
        checkConfig(folder.id);
      }
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
      if (currentFolderId !== folder.id) {
        currentFolderId = folder.id;
        checkConfig(folder.id);
      }
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

  // Re-checked per folder, not once globally - checkCredentials() is now
  // per-connector (helpers/env.js), so "config OK" for the Stripe folder
  // says nothing about whether HubSpot's is configured, and vice versa.
  // Defaults to currentFolderId so existing no-arg call sites keep working.
  async function checkConfig(folderId = currentFolderId) {
    let url = `/api/config-status?folder=${encodeURIComponent(folderId || "")}`;
    if (selectedProject && selectedConnector) {
      url += `&projectId=${encodeURIComponent(selectedProject.id)}&connectionId=${encodeURIComponent(selectedConnector.connectionId)}`;
    }
    const res = await fetch(url);
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
    // Highlighted when this is the scenario whose detail/history is showing
    // in the right panel - independent of whether it's checked for running.
    if (state.activeResultName === sc.name) row.classList.add("active");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(sc.name);
    checkbox.addEventListener("change", () => {
      if (currentFolderId !== folderId) {
        currentFolderId = folderId;
        checkConfig(folderId);
      }
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
    // Clicking the name/sub area (NOT the checkbox) shows this scenario's
    // last result and step history in the right panel - same detail view the
    // center "Test Results" list already opens on click, just reachable
    // directly from the left tree without needing to check + run it first.
    // Works even for a scenario with no result yet (renderRightPanel already
    // renders a "Not run yet" state for that case).
    info.addEventListener("click", () => {
      if (currentFolderId !== folderId) {
        currentFolderId = folderId;
        checkConfig(folderId);
      }
      state.activeResultName = sc.name;
      renderFolderScenarioList(folderId);
      renderCenterList();
      renderRightPanel();
    });
    row.appendChild(info);

    const dot = document.createElement("span");
    const status = scenarioStatus(state, sc.name);
    dot.className = "status-dot" + (status ? ` ${status}` : "");
    row.appendChild(dot);

    return row;
  }

  // A step counts as "done" once it has reached ANY terminal state. Extracted
  // so the two aggregation sites cannot drift: both used to hardcode
  // pass||fail, which meant adding a status silently stalled the progress bar
  // short of 100% and made "Steps (n/m)" under-report.
  const TERMINAL_STEP_STATUSES = ["pass", "warn", "fail"];
  const isStepDone = (s) => TERMINAL_STEP_STATUSES.includes(s.status);

  /**
   * A scenario's status, DERIVED rather than stored.
   *
   * "warn" (passed, but a step saw a 5xx) cannot come from Jest - it has no
   * such test status - so it is computed from the step warnings the
   * stepReporter delivered. Deriving it on read rather than upgrading
   * state.results on write keeps this order-independent: it does not matter
   * whether the step events or the final `result` event arrive first, and
   * renderCenterList() already re-runs on every step event.
   */
  function scenarioStatus(state, name) {
    const r = state.results[name];
    if (!r) return null;
    if (r.status !== "pass") return r.status;
    const steps = (state.steps && state.steps[name]) || {};
    return Object.values(steps).some((s) => s.warnings && s.warnings.length > 0) ? "warn" : "pass";
  }

  /** Every server-error record across a scenario's steps, for the detail pane. */
  function scenarioWarnings(state, name) {
    const steps = (state.steps && state.steps[name]) || {};
    return Object.values(steps).flatMap((s) => s.warnings || []);
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
    const status = scenarioStatus(state, sc.name);
    row.className = "result-row";
    if (state.activeResultName === sc.name) row.classList.add("active");
    if (status === "fail") row.classList.add("fail-border");
    if (status === "skipped") row.classList.add("skip-border");
    if (status === "warn") row.classList.add("warn-border");

    row.addEventListener("click", () => {
      state.activeResultName = sc.name;
      renderCenterList();
      renderRightPanel();
    });

    if (status === "running") {
      const spinner = document.createElement("span");
      spinner.className = "spinner-md";
      row.appendChild(spinner);
    } else if (status === "pass" || status === "fail" || status === "skipped" || status === "warn" || status === "cancelled") {
      const icon = document.createElement("span");
      icon.className = `result-icon ${status}`;
      // Five distinct glyphs, deliberately. A skipped scenario is NOT a tick
      // and NOT a cross - it did not run. A warned one passed, but the server
      // errored while it did. A cancelled one was killed mid-run via Stop.
      // Collapsing any of these into pass/fail hides exactly the thing that
      // made them worth their own state.
      icon.textContent =
        status === "pass" ? "✓" : status === "fail" ? "✕" : status === "warn" ? "!" : status === "cancelled" ? "■" : "⊘";
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

    // Live step progress, shown on EVERY row rather than only the selected
    // one. The right panel can only ever detail a single scenario, but a run
    // covers up to 12 concurrently - without this you'd be blind to progress
    // on all but whichever row you happened to click.
    const liveSteps = (state.steps && state.steps[sc.name]) || {};
    const done = Object.values(liveSteps).filter(isStepDone).length;
    const running = Object.entries(liveSteps).find(([, s]) => s.status === "running");
    const warnCount = scenarioWarnings(state, sc.name).length;
    if (status === "skipped") {
      // The reason replaces the step count: "0/6 steps" would read as though
      // it were about to start, when in fact it never will.
      subEl.textContent = `did not run — ${r.skipReason || "no reason given"}`;
      subEl.classList.add("result-sub-skipped");
    } else if (running) {
      // Name the step actually in flight - this is what turns a 90s wait from
      // "is it stuck?" into "it's polling a cache".
      subEl.textContent = `${done}/${sc.steps.length} · ${running[0]}`;
      subEl.classList.add("result-sub-running");
    } else if (status === "cancelled") {
      subEl.textContent = r.message || "Stopped before finishing";
    } else if (status === "warn") {
      subEl.textContent = `${done}/${sc.steps.length} steps · ${warnCount} tolerated 5xx`;
      subEl.classList.add("result-sub-warn");
    } else if (done > 0) {
      subEl.textContent = `${done}/${sc.steps.length} steps · ${sc.category}`;
    } else {
      subEl.textContent = `${sc.steps.length} steps · ${sc.category}`;
    }

    info.appendChild(nameEl);
    info.appendChild(subEl);

    // A thin progress bar, only once something has actually reported.
    if (done > 0 || running) {
      const failed = Object.values(liveSteps).some((s) => s.status === "fail");
      const warned = Object.values(liveSteps).some((s) => s.status === "warn");
      const track = document.createElement("div");
      track.className = "step-progress-track";
      const fill = document.createElement("div");
      fill.className = "step-progress-fill" + (failed ? " failed" : warned ? " warned" : "");
      fill.style.width = `${Math.round((done / Math.max(sc.steps.length, 1)) * 100)}%`;
      track.appendChild(fill);
      info.appendChild(track);
    }
    row.appendChild(info);

    // "warn" included, or a warned scenario silently loses its timing.
    if (["pass", "fail", "warn"].includes(status) && r && typeof r.duration === "number") {
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
    // A warned scenario counts in `warn` and NOT in `pass`, or the badges stop
    // summing to the selection size. `skipped` gets its own bucket too - it
    // used to fall into `pending`, which read as "hasn't started yet" for
    // something that will never run.
    let pass = 0;
    let fail = 0;
    let warn = 0;
    let skipped = 0;
    let stopped = 0;
    let pending = 0;
    for (const sc of selectedScenarios) {
      const status = scenarioStatus(state, sc.name);
      if (status === "pass") pass++;
      else if (status === "warn") warn++;
      else if (status === "fail") fail++;
      else if (status === "skipped") skipped++;
      else if (status === "cancelled") stopped++;
      else pending++;
    }
    badgesEl.classList.remove("hidden");
    clearBtn.classList.remove("hidden");
    passCountEl.textContent = String(pass);
    failCountEl.textContent = String(fail);
    warnCountEl.textContent = String(warn);
    skippedCountEl.textContent = String(skipped);
    stoppedCountEl.textContent = String(stopped);
    pendingCountEl.textContent = String(pending);
    badgeFailEl.classList.toggle("hidden", fail === 0);
    badgeWarnEl.classList.toggle("hidden", warn === 0);
    badgeSkippedEl.classList.toggle("hidden", skipped === 0);
    badgeStoppedEl.classList.toggle("hidden", stopped === 0);
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

    // Gated off by helpers/preflight.js's gatedTest() (missing/placeholder
    // credentials, or insufficient seeded data) - never actually executed,
    // so it's neither a pass nor a fail. Shown distinctly rather than
    // falling into the fail branch below, which would otherwise render an
    // empty "Error" section since Jest reports no failureMessages for a
    // skipped test.
    if (r.status === "skipped") {
      detailStatusBadgeEl.className = "status-badge skipped";
      detailStatusBadgeEl.style.background = "";
      detailStatusBadgeEl.style.color = "";
      detailStatusBadgeEl.textContent = "Skipped";
      detailDurationEl.textContent = "";

      const heading = document.createElement("span");
      heading.className = "detail-section-heading";
      heading.textContent = "Did not run";
      detailBodyEl.appendChild(heading);

      const p = document.createElement("p");
      p.className = "detail-pass-message";
      p.textContent = r.skipReason || "No reason recorded.";
      detailBodyEl.appendChild(p);

      // Stated plainly rather than implied. A reader glancing at a dashboard
      // full of green ticks needs to know this one verified nothing.
      const warn = document.createElement("p");
      warn.className = "detail-pass-message";
      warn.style.color = "var(--text-mutedmore)";
      warn.textContent =
        "This scenario verified nothing. Its assertions were never executed, so a green run " +
        "does not cover this behaviour.";
      detailBodyEl.appendChild(warn);
      return;
    }

    // Killed mid-run via the Stop button (server.js's /api/cancel-run) - not
    // a pass, not a fail, and unlike "skipped" it may have left real Peaka
    // resources behind, since Jest's afterAll() cleanup never got to run.
    // That's exactly what server.js's "cancelled" SSE event's message says,
    // shown here rather than re-worded, so this stays the ONE place that
    // wording is defined.
    if (r.status === "cancelled") {
      detailStatusBadgeEl.textContent = "Stopped";
      detailStatusBadgeEl.className = "status-badge cancelled";
      detailStatusBadgeEl.style.background = "";
      detailStatusBadgeEl.style.color = "";
      detailDurationEl.textContent = "";
      const p = document.createElement("p");
      p.className = "detail-pass-message";
      p.style.color = "var(--fail-fg)";
      p.textContent = r.message || "Stopped before finishing.";
      detailBodyEl.appendChild(p);
      return;
    }

    if (scenarioStatus(state, state.activeResultName) === "warn") {
      detailStatusBadgeEl.className = "status-badge warn";
      detailStatusBadgeEl.style.background = "";
      detailStatusBadgeEl.style.color = "";
      detailStatusBadgeEl.textContent = "Passed with server errors";
      detailDurationEl.textContent = typeof r.duration === "number" ? `${r.duration}ms` : "";

      const heading = document.createElement("span");
      heading.className = "detail-section-heading";
      heading.textContent = "Server errors";
      detailBodyEl.appendChild(heading);

      for (const w of scenarioWarnings(state, state.activeResultName)) {
        const p = document.createElement("p");
        p.className = "detail-pass-message";
        p.textContent = `${w.status} ${w.label || ""}${w.step ? ` — in "${w.step}"` : ""}`;
        detailBodyEl.appendChild(p);
        if (w.reason) {
          const why = document.createElement("p");
          why.className = "detail-pass-message";
          why.style.color = "var(--text-mutedmore)";
          why.textContent = w.reason;
          detailBodyEl.appendChild(why);
        }
      }

      // Said plainly rather than implied - a green tick with a magenta dot is
      // easy to read as "fine", and it is not.
      const note = document.createElement("p");
      note.className = "detail-pass-message";
      note.style.color = "var(--text-mutedmore)";
      note.textContent =
        "This scenario passed, but Peaka returned a 5xx. Under doc2.txt rule 6 a server error is " +
        "always a bug; it is tolerated here so the test is not permanently red, not because it is correct.";
      detailBodyEl.appendChild(note);
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
    const doneCount = Object.values(liveSteps).filter(isStepDone).length;

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
      icon.textContent =
        status === "pass"
          ? "✓"
          : status === "fail"
          ? "✕"
          : status === "warn"
          ? "!"
          : status === "running"
          ? "◍"
          : "○";
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
  /** The runner view's own controls, for the folder it is displaying. */
  function updateButtonStates() {
    const state = currentState();
    const selectedCount = state ? state.selected.size : 0;
    const running = Boolean(state && state.isRunning);
    const startable = Boolean(state) && configOk && canStartClientSide(state.folder.id);
    runAllBtn.disabled = !startable;
    runSelectedBtn.disabled = !startable || selectedCount === 0;
    runSelectedLabel.textContent = running ? "Running…" : `Run Selected (${selectedCount})`;
    runSpinner.classList.toggle("hidden", !running);
    stopRunBtn.classList.toggle("hidden", !running);
    stopRunBtn.disabled = false; // re-enabled on every render, incl. right after a click - see stopRunBtn's own listener
  }

  /**
   * Every run control on both views. A run starting or finishing changes what
   * is startable everywhere, not just where it was launched from - an
   * exclusive folder blocks all the others, and finishing unblocks them - so
   * the two are always refreshed together.
   */
  function refreshRunControls() {
    updateButtonStates();
    updateProjectRunControls();
  }

  /**
   * Starts one folder's run. Folder-explicit rather than implicitly "whatever
   * the runner is showing", because a batch from the project view starts
   * several of these at once while the runner may be displaying none of them.
   *
   * `connection` carries that folder's own project/connection - it cannot come
   * from the selectedConnector global any more, since concurrent runs each
   * have their own.
   */
  function runTests(folderId, namesFilter, connection) {
    const state = folderStates[folderId];
    if (!state) return;

    state.isRunning = true;
    state.hasRun = true;
    refreshRunControls();

    const targetNames = namesFilter || state.scenarios.map((sc) => sc.name);

    // An unfiltered run means "all of them", so mark them selected. The
    // runner's centre list and badges both render `state.selected`, not
    // `state.results` - without this a batch started from the project view
    // recorded every result correctly and then showed an empty runner when
    // you clicked in to read them. The runner's own Run All already did this
    // for itself; doing it here makes both entry points agree.
    if (!namesFilter) {
      state.selected = new Set(targetNames);
      if (state.el && state.el.selectAllCheckboxEl) state.el.selectAllCheckboxEl.checked = true;
    }

    for (const name of targetNames) {
      state.results[name] = { status: "running" };
      state.steps[name] = {}; // drop any step state from a previous run
    }
    // Auto-select the first scenario in the run if nothing is selected.
    // Without this the right panel sits on its empty state for the whole run
    // unless the user happens to click a row, which made the per-step detail
    // easy to miss entirely.
    if (!state.activeResultName || !targetNames.includes(state.activeResultName)) {
      state.activeResultName = targetNames[0];
    }
    if (folderId === currentFolderId) {
      renderFolderScenarioList(folderId);
      renderCenterList();
      if (state.activeResultName) renderRightPanel();
    }

    // Only results for scenarios THIS run actually asked for. Jest's
    // onTestFileResult reports every test in each matched file, so a
    // "Run Selected" of one scenario also reports its file-mates as pending -
    // recording those would leave a scenario showing a result it never
    // earned the next time you tick it. Filtered here rather than in the
    // reporter: HubSpot gates with maybeConcurrent/test.concurrent.skip,
    // which carries no [SKIPPED:] marker, so a marker-based filter there
    // would re-break the very reporting that was just fixed.
    const wanted = new Set(targetNames);

    const conn = connection || (selectedProject && selectedConnector
      ? { projectId: selectedProject.id, connectionId: selectedConnector.connectionId }
      : null);

    let url = `/api/run-stream?folder=${encodeURIComponent(folderId)}`;
    if (namesFilter) {
      url += `&names=${encodeURIComponent(namesFilter.join(","))}`;
    }
    if (conn && conn.projectId && conn.connectionId) {
      url += `&projectId=${encodeURIComponent(conn.projectId)}&connectionId=${encodeURIComponent(conn.connectionId)}`;
    }

    const source = new EventSource(url);

    // Scoped to THIS run. A module-level `finished` flag would let one
    // folder's completion suppress cleanup for another still in flight.
    let finished = false;
    function finishRun() {
      if (finished) return;
      finished = true;
      state.isRunning = false;
      refreshRunControls();
      if (folderId === currentFolderId) renderCenterList();
    }

    source.onmessage = (evt) => {
      const event = JSON.parse(evt.data);

      if (event.type === "step-start" || event.type === "step-pass" || event.type === "step-fail") {
        // Live per-step updates. `scenario` is attached by helpers/
        // stepReporter.js via AsyncLocalStorage, which is what keeps the four
        // concurrent tests in connector.test.js from mixing up their steps.
        if (event.scenario) {
          if (!state.steps[event.scenario]) state.steps[event.scenario] = {};
          const warnings = event.warnings || [];
          state.steps[event.scenario][event.name] = {
            // A step that passed while seeing a 5xx is "warn", not "pass" -
            // the distinction Jest itself cannot express, so it is derived
            // here from the records helpers/step.js attaches.
            status:
              event.type === "step-start"
                ? "running"
                : event.type === "step-pass"
                ? warnings.length > 0
                  ? "warn"
                  : "pass"
                : "fail",
            duration: event.duration,
            message: event.message,
            warnings,
          };
          // Refresh the centre list on every step event so per-row progress
          // updates for ALL scenarios, not just the selected one. The right
          // panel still only details the active scenario. Both are skipped
          // entirely when this folder is not the one on screen - its state is
          // still updated, so switching to it later shows everything.
          if (folderId === currentFolderId) {
            renderCenterList();
            if (state.activeResultName === event.scenario) renderRightPanel();
          }
          refreshCardFor(folderId);
        }
        return;
      }

      if (event.type === "result") {
        if (!wanted.has(event.name)) return; // a file-mate this run never asked for - see `wanted` above
        state.results[event.name] = {
          // SKIP is its own outcome. It used to collapse into "fail" here,
          // which showed a scenario gated off for missing data as a red error.
          status: event.status === "PASS" ? "pass" : event.status === "SKIP" ? "skipped" : "fail",
          skipReason: event.skipReason || null,
          duration: event.duration,
          failureMessages: event.failureMessages,
        };
        if (folderId === currentFolderId) {
          renderFolderScenarioList(folderId);
          renderCenterList();
          if (state.activeResultName === event.name) renderRightPanel();
        }
        refreshCardFor(folderId);
      } else if (event.type === "done") {
        finishRun();
        source.close();
      } else if (event.type === "cancelled") {
        // Whatever was still "running" when Stop was clicked never got a
        // real result - mark it distinctly (not pass/fail/skip) rather than
        // leaving it stuck on a spinner forever. See server.js's
        // /api/cancel-run: killing the process means afterAll() cleanup
        // never ran, so event.message carries that warning verbatim.
        for (const name of Object.keys(state.results)) {
          if (state.results[name].status === "running") {
            state.results[name] = { status: "cancelled", message: event.message };
          }
        }
        if (folderId === currentFolderId) {
          renderFolderScenarioList(folderId);
          renderCenterList();
          renderRightPanel();
        }
        refreshCardFor(folderId);
        finishRun();
        source.close();
      } else if (event.type === "fatal") {
        // Named, because with several folders running "a run failed" would
        // not say which.
        alert(`${state.folder.displayName}: test run failed unexpectedly — ${event.message}`);
        finishRun();
        source.close();
      }
    };

    source.onerror = () => {
      finishRun();
      source.close();
    };
  }

  runAllBtn.addEventListener("click", () => {
    const state = currentState();
    if (!state || !canStartClientSide(state.folder.id)) return;
    runTests(state.folder.id, null); // no filter = run everything; runTests marks them all selected
  });

  runSelectedBtn.addEventListener("click", () => {
    const state = currentState();
    if (!state || state.selected.size === 0 || !canStartClientSide(state.folder.id)) return;
    runTests(state.folder.id, Array.from(state.selected));
  });

  stopRunBtn.addEventListener("click", async () => {
    const state = currentState();
    if (!state || !state.isRunning) return;
    // Disabled immediately so a second click while the request is in flight
    // can't double-fire - re-enabled by the next render regardless (e.g. if
    // this request fails).
    stopRunBtn.disabled = true;
    // NAMES ITS FOLDER. /api/cancel-run with no body means "stop everything",
    // which was indistinguishable from "stop this one" while only a single
    // run could exist - and wrong the moment a sibling connector is running.
    await cancelRun(state.folder.id);
  });

  // ---------- Project view: run several connectors at once ----------
  projectRunSelectedBtn.addEventListener("click", () => {
    // Snapshot first: runTests() flips isRunning, which canStartClientSide()
    // reads, so iterating the live set would let the first start block the
    // rest from ever launching.
    const toRun = [...selectedConnectorIds].filter((id) => canStartClientSide(id));
    for (const folderId of toRun) {
      const entry = connectorCards.get(folderId);
      const connector = entry && entry.connector;
      runTests(folderId, null, {
        projectId: selectedProject && selectedProject.id,
        // Each folder carries its OWN connection - peaka-tables has none, and
        // a race folder borrows its parent's. Reading a single global here
        // would give concurrent runs the same connection.
        connectionId: connector && connector.connectionId,
      });
    }
    refreshRunControls();
  });

  projectStopAllBtn.addEventListener("click", async () => {
    projectStopAllBtn.disabled = true;
    await cancelRun(null); // no folder = stop everything in flight
    projectStopAllBtn.disabled = false;
  });

  /** Stops one folder's run, or every run in flight when folderId is omitted. */
  async function cancelRun(folderId) {
    try {
      await fetch("/api/cancel-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(folderId ? { folder: folderId } : {}),
      });
    } catch (_) {
      // The "cancelled" SSE event (or source.onerror) still resolves the UI
      // even if this particular request failed to send.
    }
  }

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
    await showHome();
  })();
})();
