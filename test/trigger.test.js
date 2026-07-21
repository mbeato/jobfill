import { describe, it, expect, vi } from 'vitest';
import { resolveTargetTab } from '../extension/lib/trigger.js';

function fakeOnUpdated() {
  const listeners = [];
  return {
    addListener: fn => listeners.push(fn),
    removeListener: fn => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    fire: (tabId, changeInfo) => listeners.forEach(fn => fn(tabId, changeInfo)),
  };
}

describe('resolveTargetTab', () => {
  it('(a) returns an explicit tabId as-is without querying', async () => {
    const tabsQuery = vi.fn();
    const tabsCreate = vi.fn();
    const onUpdated = fakeOnUpdated();
    const id = await resolveTargetTab({ tabId: 42 }, {}, { tabsQuery, tabsCreate, onUpdated });
    expect(id).toBe(42);
    expect(tabsQuery).not.toHaveBeenCalled();
  });

  it('(b) resolves by url to an already-open matching tab without creating one', async () => {
    const tabsQuery = vi.fn().mockResolvedValue([{ id: 7 }]);
    const tabsCreate = vi.fn();
    const onUpdated = fakeOnUpdated();
    const id = await resolveTargetTab(
      { url: 'https://boards.example.com/job/1' },
      { url: 'http://127.0.0.1:7877/dashboard.html' },
      { tabsQuery, tabsCreate, onUpdated },
    );
    expect(id).toBe(7);
    expect(tabsQuery).toHaveBeenCalledWith({ url: 'https://boards.example.com/job/1' });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('(c) creates a new tab and resolves after onUpdated fires complete', async () => {
    const tabsQuery = vi.fn().mockResolvedValue([]);
    const tabsCreate = vi.fn().mockResolvedValue({ id: 99 });
    const onUpdated = fakeOnUpdated();
    const promise = resolveTargetTab(
      { url: 'https://boards.example.com/job/2' },
      { url: 'http://127.0.0.1:7877/dashboard.html' },
      { tabsQuery, tabsCreate, onUpdated },
    );
    // let the tabsQuery/tabsCreate microtasks resolve and the onUpdated listener register
    // before simulating the tab loading: an in-progress event first (must be ignored), then complete
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    onUpdated.fire(99, { status: 'loading' });
    onUpdated.fire(99, { status: 'complete' });
    const id = await promise;
    expect(id).toBe(99);
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'https://boards.example.com/job/2', active: true });
  });

  it('(d) throws when an external caller supplies neither url nor tabId', async () => {
    const tabsQuery = vi.fn();
    const tabsCreate = vi.fn();
    const onUpdated = fakeOnUpdated();
    await expect(
      resolveTargetTab(
        {},
        { url: 'http://127.0.0.1:7877/dashboard.html' },
        { tabsQuery, tabsCreate, onUpdated },
      ),
    ).rejects.toThrow(/url or tabId/);
    expect(tabsQuery).not.toHaveBeenCalled();
  });
});
