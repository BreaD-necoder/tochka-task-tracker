const test = require("node:test");
const assert = require("node:assert/strict");
const { createTaskStore, encodeTasks } = require("../app.js");

const task = (id) => ({
  id, title: id, description: "", priority: "normal", completed: false,
  createdAt: "2026-11-16T10:00:00Z", updatedAt: "2026-11-16T10:00:00Z"
});
function fixture(raw = null) {
  const memory = { raw, writes: 0, failRead: false, failWrite: false };
  const storage = {
    getItem(key) {
      assert.equal(key, "tochka.tasks.v1");
      if (memory.failRead) throw new Error("denied");
      return memory.raw;
    },
    setItem(key, value) {
      assert.equal(key, "tochka.tasks.v1");
      if (memory.failWrite) throw new Error("quota");
      memory.writes++;
      memory.raw = value;
    }
  };
  return { memory, store: createTaskStore(() => storage), storage };
}

test("initial load never writes; empty storage is valid", () => {
  const { store, memory } = fixture();
  assert.deepEqual(store.load(), { ok: true, tasks: [] });
  assert.equal(memory.writes, 0);
  assert.equal(store.state.dirty, false);
});
test("existing v1 data loads without migration or changes", () => {
  const raw = encodeTasks([task("old")]);
  const { store, memory } = fixture(raw);
  assert.deepEqual(store.load().tasks, [task("old")]);
  assert.equal(memory.raw, raw);
  assert.equal(memory.writes, 0);
});
test("successful save clears dirty state", () => {
  const { store, memory } = fixture();
  store.load();
  assert.equal(store.save([task("new")]), true);
  assert.equal(store.state.dirty, false);
  assert.equal(memory.raw, encodeTasks([task("new")]));
});
test("write failure keeps caller data and original persisted data; retry succeeds", () => {
  const raw = encodeTasks([task("old")]);
  const { store, memory } = fixture(raw);
  const current = [task("new")];
  store.load();
  memory.failWrite = true;
  assert.equal(store.save(current), false);
  assert.equal(memory.raw, raw);
  assert.equal(current[0].id, "new");
  assert.equal(store.state.dirty, true);
  assert.equal(store.state.reason, "write");
  memory.failWrite = false;
  assert.equal(store.save(current), true);
  assert.equal(store.state.dirty, false);
});
test("initial read failure blocks writes until an explicit successful load", () => {
  const { store, memory } = fixture();
  memory.failRead = true;
  assert.equal(store.load().ok, false);
  memory.failRead = false;
  assert.equal(store.save([task("temporary")]), false);
  assert.equal(memory.writes, 0);
  assert.equal(store.state.dirty, true);
  assert.equal(store.load().ok, true);
  assert.equal(store.state.dirty, false);
});
test("storage accessor SecurityError is handled", () => {
  const store = createTaskStore(() => { throw new Error("SecurityError"); });
  assert.equal(store.load().ok, false);
  assert.equal(store.save([task("temporary")]), false);
});
for (const raw of ["{", '{"version":2,"tasks":[]}', '{"version":1,"tasks":[null]}']) {
  test(`damaged data is never overwritten: ${raw}`, () => {
    const { store, memory } = fixture(raw);
    assert.equal(store.load().ok, false);
    assert.equal(store.state.reason, "invalid");
    assert.equal(store.save([task("temporary")]), false);
    assert.equal(memory.raw, raw);
    assert.equal(memory.writes, 0);
  });
}
test("read failure immediately before save preserves dirty state and original data", () => {
  const { store, memory } = fixture();
  store.load();
  memory.failRead = true;
  assert.equal(store.save([task("new")]), false);
  assert.equal(store.state.reason, "read");
  assert.equal(store.state.dirty, true);
  assert.equal(memory.writes, 0);
});
test("two tabs: storage notification prevents overwriting another tab", () => {
  const { store: a, memory, storage } = fixture();
  const b = createTaskStore(() => storage);
  a.load(); b.load();
  a.save([task("A")]);
  b.observeExternal();
  assert.equal(b.state.conflict, true);
  assert.equal(b.save([task("B")]), false);
  assert.equal(memory.raw, encodeTasks([task("A")]));
  assert.equal(b.state.dirty, true);
});
test("pre-write check detects conflict even without a storage event", () => {
  const { store, memory } = fixture();
  store.load();
  memory.raw = encodeTasks([task("external")]);
  assert.equal(store.save([task("local")]), false);
  assert.equal(store.state.reason, "conflict");
  assert.equal(memory.writes, 0);
});
test("external removal is a conflict, not permission to recreate old tasks", () => {
  const { store, memory } = fixture(encodeTasks([task("old")]));
  store.load();
  memory.raw = null;
  store.observeExternal();
  assert.equal(store.save([task("local")]), false);
  assert.equal(memory.raw, null);
});
test("delayed event after our own save does not create a false conflict", () => {
  const { store } = fixture();
  store.load();
  store.save([task("ours")]);
  store.observeExternal();
  assert.equal(store.state.conflict, false);
});
test("explicit reload accepts external data and allows subsequent saves", () => {
  const { store, memory } = fixture();
  store.load();
  memory.raw = encodeTasks([task("external")]);
  store.save([task("local")]);
  assert.equal(store.load().tasks[0].id, "external");
  assert.equal(store.state.dirty, false);
  assert.equal(store.state.conflict, false);
  assert.equal(store.save([task("after-reload")]), true);
});
test("failed reload preserves dirty state and never changes persisted data", () => {
  const { store, memory } = fixture();
  store.load();
  memory.failWrite = true;
  store.save([task("local")]);
  memory.raw = "{broken";
  assert.equal(store.load().ok, false);
  assert.equal(store.state.dirty, true);
  assert.equal(memory.raw, "{broken");
});
test("external change after a failed save prevents unsafe retry", () => {
  const { store, memory } = fixture();
  store.load();
  memory.failWrite = true;
  store.save([task("local")]);
  memory.failWrite = false;
  memory.raw = encodeTasks([task("external")]);
  assert.equal(store.save([task("local")]), false);
  assert.equal(store.state.conflict, true);
  assert.equal(memory.writes, 0);
});
