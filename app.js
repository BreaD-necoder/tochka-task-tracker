/* No network requests or dependencies. User text is inserted only with textContent. */
(() => {
  "use strict";

  const STORAGE_KEY = "tochka.tasks.v1";
  const PRIORITIES = Object.freeze({
    high: { label: "Высокий", rank: 0 },
    normal: { label: "Обычный", rank: 1 },
    low: { label: "Низкий", rank: 2 }
  });

  function isPriority(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(PRIORITIES, value);
  }

  function validateFields(title, description, priority) {
    if (typeof title !== "string" || !title.trim() || title.trim().length > 140) {
      throw new Error("Название должно содержать от 1 до 140 символов.");
    }
    if (typeof description !== "string" || description.length > 600 || !isPriority(priority)) {
      throw new Error("Некорректное описание или приоритет.");
    }
    return { title: title.trim(), description: description.trim(), priority };
  }

  function decodeTasks(raw) {
    if (raw === null) return [];
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !Array.isArray(data.tasks)) {
      throw new Error("Неподдерживаемый формат данных.");
    }
    const ids = new Set();
    return data.tasks.map((task) => {
      if (!task || typeof task.id !== "string" || !task.id || ids.has(task.id) ||
          typeof task.completed !== "boolean" ||
          typeof task.createdAt !== "string" || !Number.isFinite(Date.parse(task.createdAt)) ||
          typeof task.updatedAt !== "string" || !Number.isFinite(Date.parse(task.updatedAt))) {
        throw new Error("Повреждённая запись задачи.");
      }
      ids.add(task.id);
      return {
        id: task.id,
        ...validateFields(task.title, task.description, task.priority),
        completed: task.completed,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt
      };
    });
  }

  function encodeTasks(tasks) {
    return JSON.stringify({ version: 1, tasks });
  }

  function selectTasks(tasks, filter, query) {
    const search = query.trim().toLocaleLowerCase("ru");
    return tasks.filter((task) => {
      const matchesFilter = filter === "all" ||
        (filter === "active" && !task.completed) ||
        (filter === "completed" && task.completed);
      return matchesFilter && task.title.toLocaleLowerCase("ru").includes(search);
    }).sort((a, b) =>
      Number(a.completed) - Number(b.completed) ||
      PRIORITIES[a.priority].rank - PRIORITIES[b.priority].rank ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      a.id.localeCompare(b.id)
    );
  }

  function getStats(tasks) {
    const completed = tasks.filter((task) => task.completed).length;
    return {
      total: tasks.length,
      active: tasks.length - completed,
      completed,
      percent: tasks.length ? Math.round(completed / tasks.length * 100) : 0
    };
  }

  // The saved raw value is a comparison token, not a transaction or a lock.
  // Injecting storage keeps failure/conflict tests independent of browser data.
  function createTaskStore(getStorage) {
    let baseline = null;
    let dirty = false;
    let conflict = false;
    let blocked = false;
    let reason = null;

    function load() {
      let raw, loaded;
      try {
        raw = getStorage().getItem(STORAGE_KEY);
      } catch {
        reason = "read";
        blocked = true;
        return { ok: false };
      }
      try {
        loaded = decodeTasks(raw);
      } catch {
        reason = "invalid";
        blocked = true;
        return { ok: false };
      }
      baseline = raw;
      dirty = conflict = blocked = false;
      reason = null;
      return { ok: true, tasks: loaded };
    }

    function observeExternal() {
      try {
        if (getStorage().getItem(STORAGE_KEY) !== baseline) {
          conflict = true;
          reason = "conflict";
        }
      } catch {
        reason = "read";
      }
    }

    function save(currentTasks) {
      dirty = true;
      if (blocked || conflict) return false;
      let storage;
      try {
        storage = getStorage();
        if (storage.getItem(STORAGE_KEY) !== baseline) {
          conflict = true;
          reason = "conflict";
          return false;
        }
      } catch {
        reason = "read";
        return false;
      }
      try {
        const raw = encodeTasks(currentTasks);
        storage.setItem(STORAGE_KEY, raw);
        baseline = raw;
        dirty = false;
        reason = null;
        return true;
      } catch {
        reason = "write";
        return false;
      }
    }

    return {
      load, save, observeExternal,
      get state() { return { dirty, conflict, blocked, reason }; }
    };
  }

  // Data and storage functions can be checked with Node.js without a DOM.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { validateFields, decodeTasks, encodeTasks, selectTasks, getStats, createTaskStore };
  }
  if (typeof document === "undefined") return;

  const $ = (id) => document.getElementById(id);
  const taskDialog = $("task-dialog");
  const deleteDialog = $("delete-dialog");
  const form = $("task-form");
  const list = $("task-list");
  const searchInput = $("search");
  let tasks = [];
  let filter = "all";
  let editingId = null;
  let deletingId = null;
  const store = createTaskStore(() => window.localStorage);
  let editorSnapshot = "";
  let dialogTrigger = null;
  let closeFocus = null;
  const cardCache = new Map();

  function announce(message) {
    $("announcer").textContent = message;
  }

  function showStorageWarning() {
    const state = store.state;
    const messages = {
      conflict: "Сохранённые задачи изменились в другой вкладке. Автоматическая запись остановлена. Текущие изменения остаются здесь. Можно загрузить сохранённые данные; несохранённые изменения будут заменены только с вашего согласия.",
      read: "Не удалось прочитать хранилище. Изменения в этой вкладке могут быть не сохранены. Проверьте доступ к хранилищу и повторите сохранение либо загрузите сохранённые данные.",
      invalid: "Сохранённые данные повреждены или имеют неизвестный формат. Исходная запись не изменена. Запись отключена; новые изменения останутся только в этой вкладке. После восстановления данных можно загрузить их снова.",
      write: "Не удалось сохранить задачи: хранилище недоступно или заполнено. Изменения пока только в этой вкладке. Освободите место или разрешите хранение и повторите сохранение."
    };
    $("storage-message").textContent = messages[state.reason];
    $("retry-storage").hidden = state.blocked || state.conflict || !state.dirty;
    $("storage-warning").hidden = false;
  }

  function load() {
    const result = store.load();
    if (!result.ok) {
      showStorageWarning();
      return false;
    }
    tasks = result.tasks;
    $("storage-warning").hidden = true;
    return true;
  }

  function persist() {
    if (store.save(tasks)) {
      $("storage-warning").hidden = true;
      return true;
    }
    showStorageWarning();
    return false;
  }

  const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });

  function renderCard(task) {
    const card = $("task-template").content.firstElementChild.cloneNode(true);
    card.dataset.id = task.id;
    card.classList.toggle("is-completed", task.completed);
    const checkbox = card.querySelector(".task-checkbox");
    checkbox.checked = task.completed;
    checkbox.setAttribute("aria-label", `${task.completed ? "Вернуть в активные" : "Отметить выполненной"}: ${task.title}`);
    card.querySelector(".task-title").textContent = task.title;
    const description = card.querySelector(".task-description");
    description.textContent = task.description;
    description.hidden = !task.description;
    const badge = card.querySelector(".priority-badge");
    badge.textContent = PRIORITIES[task.priority].label;
    badge.classList.add(`priority-${task.priority}`);
    badge.setAttribute("aria-label", `Приоритет: ${PRIORITIES[task.priority].label.toLocaleLowerCase("ru")}`);
    card.querySelector(".task-status").textContent = task.completed ? "Выполнена" : "В работе";
    const time = card.querySelector("time");
    time.dateTime = task.createdAt;
    time.textContent = `Создана ${dateFormat.format(new Date(task.createdAt))}`;
    card.querySelector(".edit-task").setAttribute("aria-label", `Редактировать: ${task.title}`);
    card.querySelector(".delete-task").setAttribute("aria-label", `Удалить: ${task.title}`);
    return card;
  }

  function renderEmpty(visibleCount) {
    $("empty-state").hidden = visibleCount > 0;
    if (visibleCount) return;
    const hasQuery = Boolean(searchInput.value.trim());
    let title, description, action;
    if (hasQuery) {
      title = "Ничего не нашлось";
      description = "Попробуйте другое название или сбросьте поиск и фильтры.";
      action = "Сбросить поиск и фильтры";
    } else if (filter === "completed" && tasks.length) {
      title = "Победы ещё впереди";
      description = "Отметьте первую выполненную задачу — она появится здесь.";
      action = "Показать все задачи";
    } else if (filter === "active" && tasks.length) {
      title = "Всё сделано. Выдохните.";
      description = "Активных задач нет. Самое время насладиться результатом или выбрать новую цель.";
      action = "Добавить задачу";
    } else {
      title = "Место для ваших планов";
      description = "Добавьте первую задачу. Маленький шаг сегодня — больше свободного времени завтра.";
      action = "Создать первую задачу";
    }
    $("empty-title").textContent = title;
    $("empty-description").textContent = description;
    $("empty-action").textContent = action;
    $("empty-action").dataset.action = hasQuery || (filter === "completed" && tasks.length) ? "reset" : "add";
  }

  function render() {
    const stats = getStats(tasks);
    const visible = selectTasks(tasks, filter, searchInput.value);
    $("total-count").textContent = stats.total;
    $("active-count").textContent = stats.active;
    $("completed-count").textContent = stats.completed;
    $("filter-all-count").textContent = stats.total;
    $("filter-active-count").textContent = stats.active;
    $("filter-completed-count").textContent = stats.completed;
    $("list-count").textContent = visible.length;
    $("task-progress").value = stats.percent;
    $("task-progress").setAttribute("aria-valuetext", `${stats.percent}% — выполнено ${stats.completed} из ${stats.total}`);
    $("progress-caption").textContent = stats.total ? `${stats.percent}% от всех задач` : "Пока чистый лист";
    $("result-summary").textContent = `Показано ${visible.length} из ${stats.total}`;
    document.querySelectorAll("[data-filter]").forEach((button) => {
      const active = button.dataset.filter === filter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const existingIds = new Set(tasks.map((task) => task.id));
    for (const id of cardCache.keys()) {
      if (!existingIds.has(id)) cardCache.delete(id);
    }
    const cards = visible.map((task) => {
      let cached = cardCache.get(task.id);
      // Task mutations replace the task object; unchanged cards can be reused.
      if (!cached || cached.task !== task) {
        cached = { task, card: renderCard(task) };
        cardCache.set(task.id, cached);
      }
      return cached.card;
    });
    const current = Array.from(list.children);
    if (cards.length !== current.length || cards.some((card, index) => card !== current[index])) {
      list.replaceChildren(...cards);
    }
    renderEmpty(visible.length);
  }

  function clearTitleError() {
    $("title-error").textContent = "Введите название, а не только пробелы.";
    $("title-error").hidden = true;
    $("task-title").removeAttribute("aria-invalid");
  }

  function openEditor(task = null) {
    dialogTrigger = document.activeElement;
    editingId = task ? task.id : null;
    form.reset();
    clearTitleError();
    $("dialog-title").textContent = task ? "Редактирование" : "Новая задача";
    $("save-task").textContent = task ? "Сохранить изменения" : "Создать задачу";
    $("task-title").value = task ? task.title : "";
    $("task-description").value = task ? task.description : "";
    $("task-priority").value = task ? task.priority : "normal";
    editorSnapshot = editorValues();
    taskDialog.showModal();
    $("task-title").focus();
  }

  function editorValues() {
    return JSON.stringify([$("task-title").value, $("task-description").value, $("task-priority").value]);
  }

  function hasDraft() {
    return taskDialog.open && editorValues() !== editorSnapshot;
  }

  function focusTask(id, selector = ".edit-task") {
    const card = Array.from(list.children).find((item) => item.dataset.id === id);
    if (card) card.querySelector(selector).focus();
    else $("add-task").focus();
  }

  function makeId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    let id;
    do {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    } while (tasks.some((task) => task.id === id));
    return id;
  }

  $("add-task").addEventListener("click", () => openEditor());
  $("task-title").addEventListener("input", clearTitleError);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!$("task-title").value.trim()) {
      $("title-error").hidden = false;
      $("task-title").setAttribute("aria-invalid", "true");
      $("task-title").focus();
      return;
    }
    if (!form.reportValidity()) return;
    let fields;
    try {
      fields = validateFields($("task-title").value, $("task-description").value, $("task-priority").value);
    } catch (error) {
      $("title-error").textContent = error.message;
      $("title-error").hidden = false;
      return;
    }
    const now = new Date().toISOString();
    const id = editingId || makeId();
    if (editingId) {
      tasks = tasks.map((task) => task.id === id ? { ...task, ...fields, updatedAt: now } : task);
    } else {
      tasks.push({ id, ...fields, completed: false, createdAt: now, updatedAt: now });
    }
    const saved = persist();
    const message = editingId ? "Изменения применены." : "Задача создана.";
    closeFocus = { id };
    taskDialog.close();
    render();
    // A new task may be hidden by the current search or filter; do not silently reset them.
    const visible = selectTasks(tasks, filter, searchInput.value).some((task) => task.id === id);
    announce(`${message}${visible ? "" : " Задача скрыта текущим поиском или фильтром."}${saved ? "" : " Изменения пока не сохранены в браузере."}`);
  });

  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => $(button.dataset.close).close());
  });
  [taskDialog, deleteDialog].forEach((dialog) => {
    dialog.addEventListener("close", () => {
      if (closeFocus) {
        focusTask(closeFocus.id, closeFocus.selector);
        closeFocus = null;
      } else if (dialogTrigger && dialogTrigger.isConnected) dialogTrigger.focus();
      else $("add-task").focus();
      if (dialog === deleteDialog) deletingId = null;
      else editingId = null;
    });
  });

  list.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const card = button.closest(".task-card");
    if (!card) return;
    const task = tasks.find((item) => item.id === card.dataset.id);
    if (!task) return;
    if (button.classList.contains("edit-task")) openEditor(task);
    if (button.classList.contains("delete-task")) {
      dialogTrigger = button;
      deletingId = task.id;
      $("delete-task-name").textContent = task.title;
      deleteDialog.showModal();
      $("cancel-delete").focus();
    }
  });

  list.addEventListener("change", (event) => {
    if (!event.target.matches(".task-checkbox")) return;
    const id = event.target.closest(".task-card").dataset.id;
    const completed = event.target.checked;
    tasks = tasks.map((task) => task.id === id ? { ...task, completed, updatedAt: new Date().toISOString() } : task);
    const saved = persist();
    render();
    focusTask(id, ".task-checkbox");
    announce(`${completed ? "Задача выполнена. Отличная работа!" : "Задача снова в работе."}${saved ? "" : " Изменение пока не сохранено."}`);
  });

  $("confirm-delete").addEventListener("click", () => {
    if (!deletingId) return;
    const index = tasks.findIndex((task) => task.id === deletingId);
    if (index === -1) return;
    const visible = selectTasks(tasks, filter, searchInput.value);
    const position = visible.findIndex((task) => task.id === deletingId);
    const next = visible[position + 1] || visible[position - 1];
    tasks.splice(index, 1);
    const saved = persist();
    closeFocus = { id: next ? next.id : null };
    deleteDialog.close();
    render();
    announce(`Задача удалена.${saved ? "" : " Удаление пока не сохранено."}`);
  });

  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      render();
      announce($("result-summary").textContent);
    });
  });
  searchInput.addEventListener("input", () => {
    render();
    announce($("result-summary").textContent);
  });
  $("empty-action").addEventListener("click", () => {
    if ($("empty-action").dataset.action === "reset") {
      filter = "all";
      searchInput.value = "";
      render();
      searchInput.focus();
      announce($("result-summary").textContent);
    } else openEditor();
  });
  $("retry-storage").addEventListener("click", () => {
    if (persist()) announce("Все текущие изменения сохранены в браузере.");
  });

  function reloadSaved() {
    // Validate first: a failed reload must not discard the in-memory tasks.
    if (!load()) return;
    taskDialog.close();
    deleteDialog.close();
    render();
    $("add-task").focus();
    announce("Загружены актуальные сохранённые задачи.");
  }

  $("reload-storage").addEventListener("click", () => {
    if (store.state.dirty || hasDraft()) {
      $("reload-dialog").showModal();
      $("cancel-reload").focus();
    } else reloadSaved();
  });
  $("confirm-reload").addEventListener("click", () => {
    $("reload-dialog").close();
    reloadSaved();
  });
  $("reload-dialog").addEventListener("close", () => $("reload-storage").focus());

  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    // Read the latest value: queued events can describe an older write.
    store.observeExternal();
    if (store.state.reason) showStorageWarning();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!store.state.dirty && !hasDraft()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  const today = new Date();
  $("today").dateTime = today.toISOString();
  $("today").textContent = new Intl.DateTimeFormat("ru-RU", {
    weekday: "short", day: "numeric", month: "long", year: "numeric"
  }).format(today);
  load();
  render();
})();
