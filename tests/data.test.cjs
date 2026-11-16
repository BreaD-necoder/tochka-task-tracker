const test = require("node:test");
const assert = require("node:assert/strict");
const { validateFields, decodeTasks, encodeTasks, selectTasks, getStats } = require("../app.js");

const task = (id, overrides = {}) => ({
  id, title: `Задача ${id}`, description: "", priority: "normal", completed: false,
  createdAt: "2026-11-16T10:00:00Z", updatedAt: "2026-11-16T10:00:00Z", ...overrides
});

test("fields are trimmed; multiline descriptions remain multiline", () => {
  assert.deepEqual(validateFields("  Название  ", "  Один\nДва  ", "high"),
    { title: "Название", description: "Один\nДва", priority: "high" });
});
test("title length boundaries", () => {
  assert.equal(validateFields("x".repeat(140), "", "normal").title.length, 140);
  for (const title of ["", "   ", "x".repeat(141), null, 1, {}, []]) {
    assert.throws(() => validateFields(title, "", "normal"));
  }
});
test("description length and types", () => {
  assert.equal(validateFields("x", "x".repeat(600), "normal").description.length, 600);
  for (const description of ["x".repeat(601), null, 1, {}, []]) {
    assert.throws(() => validateFields("x", description, "normal"));
  }
});
for (const priority of ["high", "normal", "low"]) {
  test(`accept priority ${priority}`, () => assert.equal(validateFields("x", "", priority).priority, priority));
}
test("reject invalid, inherited and non-string priorities", () => {
  for (const priority of ["", "urgent", "toString", "__proto__", null, 1, {}, ["high"]]) {
    assert.throws(() => validateFields("x", "", priority));
  }
});
test("roundtrip preserves the v1 envelope and task fields", () => {
  const tasks = [task("1", { description: "Первая\nВторая", completed: true })];
  assert.equal(JSON.parse(encodeTasks(tasks)).version, 1);
  assert.deepEqual(decodeTasks(encodeTasks(tasks)), tasks);
  assert.deepEqual(decodeTasks(null), []);
});
test("reject malformed JSON and unsupported envelopes", () => {
  for (const raw of ["{", "", "null", "[]", "{}", '{"version":2,"tasks":[]}', '{"version":1,"tasks":{}}']) {
    assert.throws(() => decodeTasks(raw));
  }
});
test("reject duplicate, missing and non-string identifiers", () => {
  assert.throws(() => decodeTasks(encodeTasks([task("1"), task("1")])));
  for (const id of ["", null, 1, {}]) assert.throws(() => decodeTasks(encodeTasks([task(id)])));
});
test("reject invalid dates and field types in stored tasks", () => {
  for (const overrides of [
    { createdAt: "bad" }, { updatedAt: "bad" }, { createdAt: 1 }, { updatedAt: null },
    { completed: "false" }, { title: null }, { description: false }, { priority: "urgent" }
  ]) assert.throws(() => decodeTasks(encodeTasks([task("1", overrides)])));
  assert.throws(() => decodeTasks('{"version":1,"tasks":[null]}'));
});
test("search ignores Russian case and surrounding spaces, searches titles only", () => {
  const tasks = [task("1", { title: "Проверить Окружение", description: "скрытое" })];
  assert.equal(selectTasks(tasks, "all", " ОКРУЖЕНИЕ ").length, 1);
  assert.equal(selectTasks(tasks, "all", "скрытое").length, 0);
});
test("filters intersect with search", () => {
  const tasks = [task("1"), task("2", { completed: true })];
  assert.equal(selectTasks(tasks, "all", "").length, 2);
  assert.equal(selectTasks(tasks, "active", "").length, 1);
  assert.equal(selectTasks(tasks, "completed", "").length, 1);
  assert.equal(selectTasks(tasks, "completed", "Задача 1").length, 0);
});
test("sort by status, priority, newest date, then ID; do not mutate input", () => {
  const tasks = [
    task("done", { priority: "high", completed: true }),
    task("low", { priority: "low" }), task("normal"),
    task("old", { priority: "high" }),
    task("b", { priority: "high", createdAt: "2026-11-17T10:00:00Z" }),
    task("a", { priority: "high", createdAt: "2026-11-17T10:00:00Z" })
  ];
  const before = encodeTasks(tasks);
  assert.deepEqual(selectTasks(tasks, "all", "").map(t => t.id), ["a", "b", "old", "normal", "low", "done"]);
  assert.equal(encodeTasks(tasks), before);
});
test("statistics include all tasks with integer percentage", () => {
  assert.deepEqual(getStats([]), { total: 0, active: 0, completed: 0, percent: 0 });
  assert.deepEqual(getStats([task("1"), task("2"), task("3", { completed: true })]),
    { total: 3, active: 2, completed: 1, percent: 33 });
});
test("HTML-looking user text is preserved as data, not interpreted", () => {
  const title = "<img src=x onerror=alert(1)>";
  assert.equal(decodeTasks(encodeTasks([task("1", { title })]))[0].title, title);
});
