import { describe, it, expect, vi } from 'vitest';
import { resolveTargetTab, CREATED_TAB_TIMEOUT_MS } from '../extension/lib/trigger.js';

// Works for both onUpdated (fire(tabId, changeInfo)) and onRemoved (fire(tabId)).
function fakeEvent() {
  const listeners = [];
  return {
    addListener: fn => listeners.push(fn),
    removeListener: fn => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    fire: (...args) => [...listeners].forEach(fn => fn(...args)),
    count: () => listeners.length,
  };
}

function makeDeps(overrides = {}) {
  return {
    tabsQuery: vi.fn(),
    tabsCreate: vi.fn(),
    onUpdated: fakeEvent(),
    onRemoved: fakeEvent(),
    ...overrides,
  };
}

describe('resolveTargetTab', () => {
  it('(a) returns an explicit tabId as-is without querying', async () => {
    const deps = makeDeps();
    const id = await resolveTargetTab({ tabId: 42 }, {}, deps);
    expect(id).toBe(42);
    expect(deps.tabsQuery).not.toHaveBeenCalled();
  });

  it('(b) resolves by url to an already-open matching tab without creating one', async () => {
    const deps = makeDeps({ tabsQuery: vi.fn().mockResolvedValue([{ id: 7 }]) });
    const id = await resolveTargetTab(
      { url: 'https://boards.example.com/job/1' },
      { url: 'http://127.0.0.1:7877/dashboard.html' },
      deps,
    );
    expect(id).toBe(7);
    expect(deps.tabsQuery).toHaveBeenCalledWith({ url: 'https://boards.example.com/job/1' });
    expect(deps.tabsCreate).not.toHaveBeenCalled();
  });

  it('(b2) strips the #fragment before querying — fragments are invalid match patterns', async () => {
    const deps = makeDeps({ tabsQuery: vi.fn().mockResolvedValue([{ id: 8 }]) });
    const id = await resolveTargetTab(
      { url: 'https://boards.example.com/job/1#app' },
      { url: 'http://127.0.0.1:7877/dashboard.html' },
      deps,
    );
    expect(id).toBe(8);
    expect(deps.tabsQuery).toHaveBeenCalledWith({ url: 'https://boards.example.com/job/1' });
  });

  it('(b3) falls through to tab creation when tabs.query rejects the pattern', async () => {
    const deps = makeDeps({
      tabsQuery: vi.fn().mockRejectedValue(new Error('Invalid url pattern')),
      tabsCreate: vi.fn().mockResolvedValue({ id: 11 }),
    });
    const promise = resolveTargetTab(
      { url: 'https://boards.example.com/job/*/apply' },
      { url: 'http://127.0.0.1:7877/dashboard.html' },
      deps,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    deps.onUpdated.fire(11, { status: 'complete' });
    await expect(promise).resolves.toBe(11);
    expect(deps.tabsCreate).toHaveBeenCalled();
  });

  it('(c) creates a new tab, resolves after onUpdated fires complete, and cleans up listeners', async () => {
    const deps = makeDeps({
      tabsQuery: vi.fn().mockResolvedValue([]),
      tabsCreate: vi.fn().mockResolvedValue({ id: 99 }),
    });
    const promise = resolveTargetTab(
      { url: 'https://boards.example.com/job/2' },
      { url: 'http://127.0.0.1:7877/dashboard.html' },
      deps,
    );
    // let the tabsQuery/tabsCreate microtasks resolve and the onUpdated listener register
    // before simulating the tab loading: an in-progress event first (must be ignored), then complete
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    deps.onUpdated.fire(99, { status: 'loading' });
    deps.onUpdated.fire(99, { status: 'complete' });
    const id = await promise;
    expect(id).toBe(99);
    expect(deps.tabsCreate).toHaveBeenCalledWith({ url: 'https://boards.example.com/job/2', active: true });
    expect(deps.onUpdated.count()).toBe(0);
    expect(deps.onRemoved.count()).toBe(0);
  });

  it('(c2) rejects and cleans up when the created tab is closed before completing', async () => {
    const deps = makeDeps({
      tabsQuery: vi.fn().mockResolvedValue([]),
      tabsCreate: vi.fn().mockResolvedValue({ id: 99 }),
    });
    const promise = resolveTargetTab(
      { url: 'https://boards.example.com/job/2' },
      { url: 'http://127.0.0.1:7877/dashboard.html' },
      deps,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    deps.onRemoved.fire(99);
    await expect(promise).rejects.toThrow(/closed before/);
    expect(deps.onUpdated.count()).toBe(0);
    expect(deps.onRemoved.count()).toBe(0);
  });

  it('(c3) rejects and cleans up when the created tab never finishes loading', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        tabsQuery: vi.fn().mockResolvedValue([]),
        tabsCreate: vi.fn().mockResolvedValue({ id: 99 }),
      });
      const promise = resolveTargetTab(
        { url: 'https://boards.example.com/job/2' },
        { url: 'http://127.0.0.1:7877/dashboard.html' },
        deps,
      );
      const expectation = expect(promise).rejects.toThrow(/did not finish loading/);
      await vi.advanceTimersByTimeAsync(CREATED_TAB_TIMEOUT_MS);
      await expectation;
      expect(deps.onUpdated.count()).toBe(0);
      expect(deps.onRemoved.count()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(d) throws when an external caller supplies neither url nor tabId', async () => {
    const deps = makeDeps();
    await expect(
      resolveTargetTab({}, { url: 'http://127.0.0.1:7877/dashboard.html' }, deps),
    ).rejects.toThrow(/url or tabId/);
    expect(deps.tabsQuery).not.toHaveBeenCalled();
  });
});
