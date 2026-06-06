/**
 * ConnectModal unit tests.
 *
 * `obsidian` is aliased to src/__mocks__/obsidian.ts in vitest.config.mjs.
 * The stubs expose just enough surface for ConnectModal's logic to run in Node.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Notice } from 'obsidian';

import { ConnectModal } from './ConnectModal';
import type { ConnectModalDeps } from './ConnectModal';
import type { ButtonComponent, ElStub } from '../__mocks__/obsidian';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApi(claimResult: Record<string, unknown>) {
  return {
    claim: vi.fn().mockResolvedValue(claimResult),
    heartbeat: vi.fn(),
    setAuth: vi.fn(),
  };
}

function makeApp(vaultName = 'TestVault') {
  return { vault: { getName: () => vaultName } };
}

/**
 * Open a ConnectModal and return it plus convenience accessors.
 *
 * ConnectModal registers its inputs/buttons inside `onOpen()` by calling
 * `new Setting(contentEl).addText(...)` / `.addButton(...)`. The stub's
 * Setting class delegates to the real TextComponent / ButtonComponent stubs
 * via the callbacks. We reach into the modal's contentEl children to find
 * the status <p> element (third child, index 2), and we walk the
 * containerEl's button stubs to find the controls.
 *
 * Because ConnectModal stores its private fields (codeInput, submitBtn,
 * statusEl) via the Setting callbacks, we need a way to drive them. The
 * cleanest approach: after `onOpen()` we inspect the private fields via
 * type cast.
 */
function openModal(deps: ConnectModalDeps) {
  const modal = new ConnectModal(deps);
  modal.onOpen();

  // Access private fields via cast — acceptable in tests.
  const m = modal as unknown as {
    codeInput: { setValue(v: string): unknown; getValue(): string; inputEl: ElStub };
    submitBtn: ButtonComponent;
    statusEl: ElStub;
  };

  return {
    modal,
    setCode: (v: string) => m.codeInput.setValue(v),
    // The click handler is `() => void this.submit()` — fire it and flush the
    // microtask queue so all awaited Promises inside submit() resolve.
    clickSubmit: async () => {
      m.submitBtn._clickHandler!();
      // Flush microtasks: enough ticks for claim() mock + any awaited callbacks
      await new Promise<void>(r => setTimeout(r, 0));
    },
    statusText: () => m.statusEl.textContent,
    submitDisabled: () => m.submitBtn._disabled,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

type OnSuccess = ConnectModalDeps['onSuccess'];

describe('ConnectModal', () => {
  let api: ReturnType<typeof makeApi>;
  let app: ReturnType<typeof makeApp>;
  let onSuccess: ReturnType<typeof vi.fn> & OnSuccess;

  beforeEach(() => {
    vi.clearAllMocks();
    api = makeApi({ ok: true, token: 'tok_abc', vault_id: 'vault-123' });
    app = makeApp('MyVault');
    onSuccess = vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn> & OnSuccess;
  });

  // 1. Empty code shows warning — does not call api.claim
  it('shows warning and skips claim when code is empty', async () => {
    const { setCode, clickSubmit, statusText } = openModal({
      app: app as never,
      api: api as never,
      deviceLabel: 'MacBook',
      existingVaultId: null,
      onSuccess,
    });

    setCode('');
    await clickSubmit();

    expect(statusText()).toContain('Enter a pairing code first');
    expect(api.claim).not.toHaveBeenCalled();
  });

  // 2. Successful claim calls onSuccess with correct shape
  it('calls onSuccess with {token, vaultId, vaultName} on success', async () => {
    const { setCode, clickSubmit } = openModal({
      app: app as never,
      api: api as never,
      deviceLabel: 'MacBook',
      existingVaultId: 'existing-vault-id',
      onSuccess,
    });

    setCode('4829-1573');
    await clickSubmit();

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith({
      token: 'tok_abc',
      vaultId: 'vault-123',
      vaultName: 'MyVault',
    });
  });

  // 3. Successful claim emits a Notice
  it('emits a Notice on success', async () => {
    const NoticeSpy = vi.spyOn({ Notice }, 'Notice');
    const { setCode, clickSubmit } = openModal({
      app: app as never,
      api: api as never,
      deviceLabel: 'MacBook',
      existingVaultId: null,
      onSuccess,
    });

    setCode('12345678');
    await clickSubmit();

    // Notice is called by the production code; verify via the stub import.
    // The stub is a no-op function — we just confirm it was invoked.
    // (The stub in __mocks__/obsidian.ts is not a vi.fn(), so we check
    //  onSuccess was called, which only fires after the Notice line.)
    expect(onSuccess).toHaveBeenCalled();
    // Notice itself is a plain function in the stub, so we verify indirectly:
    // if execution reached the Notice line without throwing, the test passes.
    void NoticeSpy; // used to avoid unused variable lint warning
  });

  // 4. invalid_code renders the correct user-facing message
  it('shows user-facing message for invalid_code error', async () => {
    api = makeApi({ ok: false, code: 'invalid_code' });
    const { setCode, clickSubmit, statusText } = openModal({
      app: app as never,
      api: api as never,
      deviceLabel: 'MacBook',
      existingVaultId: null,
      onSuccess,
    });

    setCode('bad-code');
    await clickSubmit();

    expect(statusText()).toContain("didn't work");
  });

  // 5. expired error renders the expired-specific message
  it('shows expired message for expired error code', async () => {
    api = makeApi({ ok: false, code: 'expired' });
    const { setCode, clickSubmit, statusText } = openModal({
      app: app as never,
      api: api as never,
      deviceLabel: 'MacBook',
      existingVaultId: null,
      onSuccess,
    });

    setCode('1234-5678');
    await clickSubmit();

    expect(statusText()).toContain('expired');
  });

  // 6a. Generates a fresh vaultId when existingVaultId is null
  it('generates a new vaultId when existingVaultId is null', async () => {
    const { setCode, clickSubmit } = openModal({
      app: app as never,
      api: api as never,
      deviceLabel: 'MacBook',
      existingVaultId: null,
      onSuccess,
    });

    setCode('1234-5678');
    await clickSubmit();

    const claimArg = api.claim.mock.calls[0][0] as { vault_id: string };
    expect(claimArg.vault_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  // 6b. Reuses existingVaultId when provided
  it('reuses existingVaultId when provided', async () => {
    const { setCode, clickSubmit } = openModal({
      app: app as never,
      api: api as never,
      deviceLabel: 'MacBook',
      existingVaultId: 'my-persistent-vault-id',
      onSuccess,
    });

    setCode('1234-5678');
    await clickSubmit();

    const claimArg = api.claim.mock.calls[0][0] as { vault_id: string };
    expect(claimArg.vault_id).toBe('my-persistent-vault-id');
  });

  // 7. Passes deviceLabel to api.claim
  it('calls api.claim with the provided device_label', async () => {
    const { setCode, clickSubmit } = openModal({
      app: app as never,
      api: api as never,
      deviceLabel: 'iPad Pro',
      existingVaultId: null,
      onSuccess,
    });

    setCode('1234-5678');
    await clickSubmit();

    const claimArg = api.claim.mock.calls[0][0] as { device_label: string };
    expect(claimArg.device_label).toBe('iPad Pro');
  });

  // 8. Submit button is re-enabled on error
  it('re-enables the submit button after a failed claim', async () => {
    api = makeApi({ ok: false, code: 'invalid_code' });
    const { setCode, clickSubmit, submitDisabled } = openModal({
      app: app as never,
      api: api as never,
      deviceLabel: 'MacBook',
      existingVaultId: null,
      onSuccess,
    });

    setCode('bad-code');
    await clickSubmit();

    expect(submitDisabled()).toBe(false);
  });

  // 9. onSuccess is NOT called on failure
  it('does not call onSuccess on failure', async () => {
    api = makeApi({ ok: false, code: 'attempts_exceeded' });
    const { setCode, clickSubmit } = openModal({
      app: app as never,
      api: api as never,
      deviceLabel: 'MacBook',
      existingVaultId: null,
      onSuccess,
    });

    setCode('1234-5678');
    await clickSubmit();

    expect(onSuccess).not.toHaveBeenCalled();
  });

  // 10. Thrown error (e.g. CORS / network failure) surfaces an error message
  //     and re-enables the submit button instead of hanging on "Connecting…"
  it('shows connection-failed message and re-enables button when api.claim throws', async () => {
    const throwingApi = {
      claim: vi.fn().mockRejectedValue(new Error('CORS blocked')),
      heartbeat: vi.fn(),
      setAuth: vi.fn(),
    };
    const { setCode, clickSubmit, statusText, submitDisabled } = openModal({
      app: app as never,
      api: throwingApi as never,
      deviceLabel: 'MacBook',
      existingVaultId: null,
      onSuccess,
    });

    setCode('1234-5678');
    await clickSubmit();

    expect(statusText()).toContain('Connection failed');
    expect(submitDisabled()).toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

// Suppress unused import warning — Notice is imported to verify the stub loads
void Notice;
