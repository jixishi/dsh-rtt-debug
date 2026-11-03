/**
 * Client half entry: register the panel as a sidebar page.
 *
 * The spec asks for the SAME view on two surfaces (D3), so this module does
 * both registrations against one component:
 *
 *   - the **native right sidebar** (`ctx.sidebarRightTabs` + the keyed
 *     `sidebar.right.pane.tab` slot) — stage one declares the tab TYPE, stage
 *     two supplies its BODY under the same id;
 *   - the **sidebar workbench** (`ctx.betterSidebar.registerTab`) when that
 *     plugin is installed.
 *
 * Neither registration is required: if only one host is present the other is
 * skipped, so the plugin degrades instead of failing to activate.
 */

import { createElement } from 'react'
import { RttDebugPanel } from './panel.tsx'
import { PANEL_CSS } from './styles.ts'
import { setLanguage, t } from './locales.ts'

export const name = 'dsh-rtt-debug'

/**
 * Structural view of the client cordis context.
 *
 * Declared here rather than imported from `@deepseek-ai/cordis`: the plugin
 * takes no build-time dependency on the host's private packages, so it keeps
 * compiling against host versions whose type packages are not installed. Every
 * member is optional, which is what lets `apply` degrade instead of throwing
 * when a surface is missing.
 *
 * NOTE — service reads: cordis resolves services through a proxy whose `get`
 * trap throws `cannot get property "<name>" without inject` for any service the
 * fiber did not declare. `ctx.get(name)` is the ungated optional lookup; the
 * declared `ctx.<name>` form is only legal for names listed in `inject`.
 */
interface Context {
  effect(callback: () => (() => void) | void, label?: string): void
  get?(name: string): unknown
  inject?(names: string[], callback: (injected: InjectedContext) => void): () => void
}

/**
 * The context handed to an `inject` callback.
 *
 * It is a real cordis context, so it carries `effect`: registering inside it
 * ties the registration to the waiting fiber, which is what disposes it when
 * the awaited service goes away and re-runs the callback when it returns.
 */
interface InjectedContext {
  get(name: string): unknown
  effect(callback: () => (() => void) | void, label?: string): void
}

/** Tab kind used by the native sidebar and by the workbench registration. */
const KIND = 'rtt-debug'
/** Implementation id — also the key the body slot registers under. */
const IMPL_ID = 'dsh-rtt-debug'

/**
 * Inject the stylesheet once per document.
 *
 * A `<style data-plugin>` element is used so the host's HMR teardown can find
 * and remove it, matching how built-in client plugins inject their CSS.
 */
function injectStyles(): () => void {
  const marker = 'dsh-rtt-debug/styles'
  const existing = document.querySelector(`style[data-plugin="${marker}"]`)
  if (existing !== null) return () => { /* owned by an earlier activation */ }
  const style = document.createElement('style')
  style.setAttribute('data-plugin', marker)
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
  return () => style.remove()
}

/** Read the host's active language, when a locale service is reachable. */
function syncLanguage(ctx: Context): void {
  // Optional service: `ctx.get` is the ungated lookup, so an absent (or
  // not-yet-provided) locale service yields undefined instead of throwing.
  const locale = ctx.get?.('locale') as { active?: string; get?: () => string } | undefined
  const active = locale?.active ?? locale?.get?.()
  setLanguage(typeof active === 'string' ? active : undefined)
}

export function apply(ctx: Context): void {
  const disposers: (() => void)[] = []

  syncLanguage(ctx)
  disposers.push(injectStyles())

  const panel = (sessionId?: string): ReturnType<typeof createElement> =>
    createElement(RttDebugPanel, sessionId === undefined ? {} : { sessionId })

  /* ───────────────────── entry A: native right sidebar ───────────────────── */

  // The registry must be awaited as a SERVICE, not via a slot declaration.
  // Ordering trap documented by the sidebar plugin itself: the native seat
  // declares `sidebar.right.pane.tab` BEFORE it provides `sidebarRightTabs`, so
  // registering inside a declaration callback reads the service as missing —
  // and since the declaration never collapses, nothing would ever register.
  // `ctx.inject` re-runs this body whenever the service appears or reappears,
  // which is the lifecycle the registrations need.
  //
  // The disposer below is therefore registered on `injected` (the waiting fiber),
  // NOT on the outer `ctx`. Both registries reject a second live entry: the tab
  // registry throws `tab type id "dsh-rtt-debug" is already registered`, and the
  // keyed slot throws for a duplicate key. Hanging the disposer off the outer ctx
  // would keep both alive across a service disappearance, so the re-run would
  // register a second time into a registry that still held the first.
  // Owned by `injected`, the disposer runs as the child fiber tears down — the
  // release happens BEFORE any re-run, keeping exactly one live registration.
  ctx.inject?.(['sidebarRightTabs'], injected => {
    const tabs = injected.get('sidebarRightTabs') as NativeTabRegistry | undefined
    if (tabs === undefined) return
    const slots = injected.get('slots') as SlotRegistry | undefined
    if (slots === undefined) return

    // Stage one: the tab TYPE.
    const disposeType = tabs.register({
      id: IMPL_ID,
      kind: KIND,
      // No `patterns`: this is a page type, opened by kind rather than by
      // resource address.
      priority: 'extension',
      title: () => t('tab.title'),
      guide: [{
        order: 40,
        title: () => t('tab.title'),
        description: () => t('tab.description'),
      }],
    })

    // Stage two: the BODY, keyed by the same implementation id.
    const body = slots.inject('sidebar.right.pane.tab', () => slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: IMPL_ID,
        inject: () => ({}),
      },
      (props: { tab?: { id?: string } }) => panel(props.tab?.id),
    ))

    // Release order is unchanged: the body's slot entry goes first, then the tab
    // type. Both are owned by the waiting fiber (see the comment above).
    injected.effect(() => () => {
      body()
      disposeType()
    }, 'dsh-rtt-debug: native sidebar tab')
  })

  /* ───────────────────── entry B: sidebar workbench ─────────────────────── */

  // Optional dependency, soft-waited the same way as entry A.
  //
  // `ctx.betterSidebar` is NOT legal here: cordis only permits that form for a
  // service named in the plugin's `inject`, and reading it otherwise throws
  // `cannot get property "betterSidebar" without inject` — which aborts `apply`
  // and fails the whole loader entry. `ctx.get` is the ungated lookup.
  //
  // The workbench plugin is a SIBLING fiber, and nothing orders the two against
  // each other (`dsh.client.inject` is a bundle-arrival edge, not a cordis
  // dependency), so a one-shot `ctx.get` would silently drop this entry
  // whenever the workbench happens to activate after us. The nested `ctx.inject`
  // re-runs this body when the service appears or reappears, and parks only its
  // own child fiber — never this one — so a missing workbench still degrades to
  // entry A instead of failing to activate (D3).
  ctx.inject?.(['betterSidebar'], injected => {
    const workbench = injected.get('betterSidebar') as WorkbenchRegistry | undefined
    if (workbench === undefined) return

    injected.effect(() => workbench.registerTab({
      id: `${IMPL_ID}:panel`,
      title: () => t('tab.title'),
      description: () => t('tab.description'),
      order: 70,
      single: true,
      component: () => panel(),
    }), 'dsh-rtt-debug: workbench tab')
  })

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-rtt-debug: client registrations')
}

/* ────────────────────────── host service shapes ───────────────────────────── */

/** The native tab registry, as used by DSH 0.1.5's right sidebar. */
interface NativeTabRegistry {
  register(definition: {
    id: string
    kind: string
    patterns?: readonly string[]
    priority?: 'extension' | 'builtin' | 'fallback'
    canOpen?: (address: string) => boolean
    title: (address: string) => string
    guide?: readonly { order: number; title: () => string; description?: () => string }[]
  }): () => void
}

/**
 * The keyed slot registry.
 *
 * `inject` waits for the slot DECLARATION to appear and re-runs its callback,
 * which is the documented way to register a body into a slot another package
 * declares.
 */
interface SlotRegistry {
  register(
    declaration: { name: string; key: string; inject: (sessionId: string) => Record<string, unknown> },
    component: (props: { tab?: { id?: string }; sessionId?: string }) => unknown,
  ): () => void
  inject(slot: string, callback: () => (() => void) | void): () => void
}

/** The workbench tab registry exposed by the sidebar plugin. */
interface WorkbenchRegistry {
  registerTab(descriptor: {
    id: string
    title: () => string
    description?: () => string
    order?: number
    single?: boolean
    component: () => unknown
  }): () => void
}

/** Exported for tests and for the host to open the panel programmatically. */
export { KIND as TAB_KIND, RttDebugPanel }
