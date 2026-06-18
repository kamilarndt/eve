/**
 * The `react-reconciler` host config — the seam where React's commit cycle
 * drives our terminal node tree. Method set verified against
 * react-reconciler@0.33.0 + react@19.2.6 on Node (the 0.31+ priority and
 * transition hooks below are required, not optional). The paint trigger is
 * {@link resetAfterCommit}, which fires the container's `onCommit` once per
 * commit; the runtime hangs layout + rasterization off that.
 */
import { createContext } from "react";
import ReactReconciler from "react-reconciler";

import {
  appendChild,
  createElement,
  createText,
  insertBefore,
  removeChild,
  syncStyle,
  type ElementNode,
  type ElementType,
  type HostNode,
  type TextNode,
} from "./nodes.js";

/** React's DefaultEventPriority lane (0.31+ priority API). */
const DEFAULT_EVENT_PRIORITY = 0b0000000000000000000000000010000;
let currentUpdatePriority = DEFAULT_EVENT_PRIORITY;

type Props = Record<string, unknown>;

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  isPrimaryRenderer: true,
  noTimeout: -1 as const,

  // host context (unused for now, but must be present + non-undefined)
  getRootHostContext: () => ({}),
  getChildHostContext: (parentContext: unknown) => parentContext,
  getPublicInstance: (instance: unknown) => instance,

  // creation
  createInstance: (type: string, props: Props): ElementNode =>
    createElement(type as ElementType, props),
  createTextInstance: (text: string): TextNode => createText(text),
  shouldSetTextContent: () => false,

  // initial tree
  appendInitialChild: (parent: ElementNode, child: HostNode) => appendChild(parent, child),
  finalizeInitialChildren: () => false,

  // commit boundary — the paint trigger
  prepareForCommit: () => null,
  resetAfterCommit: (container: ElementNode) => {
    container.onCommit?.();
  },

  // updates — 0.33 signature: (instance, type, prevProps, nextProps, handle).
  // The last arg is the fiber handle, NOT props; use the named nextProps.
  prepareUpdate: (_instance: ElementNode, _type: string, oldProps: Props, newProps: Props) =>
    oldProps === newProps ? null : newProps,
  commitUpdate: (instance: ElementNode, _type: string, _prevProps: Props, nextProps: Props) => {
    instance.props = nextProps;
    syncStyle(instance); // re-apply layout style to the Yoga node
  },
  commitTextUpdate: (textInstance: TextNode, _old: string, next: string) => {
    textInstance.value = next;
    // Mark the enclosing eve-text (a Yoga leaf) dirty so it re-measures.
    textInstance.parent?.yoga.markDirty();
  },

  // mutation
  appendChild: (parent: ElementNode, child: HostNode) => appendChild(parent, child),
  appendChildToContainer: (container: ElementNode, child: HostNode) =>
    appendChild(container, child),
  insertBefore: (parent: ElementNode, child: HostNode, before: HostNode) =>
    insertBefore(parent, child, before),
  insertInContainerBefore: (container: ElementNode, child: HostNode, before: HostNode) =>
    insertBefore(container, child, before),
  removeChild: (parent: ElementNode, child: HostNode) => removeChild(parent, child),
  removeChildFromContainer: (container: ElementNode, child: HostNode) =>
    removeChild(container, child),
  clearContainer: (container: ElementNode) => {
    // Detach and free each child's Yoga node too; clearing only the JS array
    // leaves the children attached to the container's Yoga node, where they get
    // laid out as phantoms and leak native memory.
    for (const child of container.children) {
      if (child.kind === "element") {
        container.yoga.removeChild(child.yoga);
        child.yoga.freeRecursive();
      }
    }
    container.children = [];
  },

  // scheduling
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,

  // priority API (react-reconciler 0.31+)
  setCurrentUpdatePriority: (priority: number) => {
    currentUpdatePriority = priority;
  },
  getCurrentUpdatePriority: () => currentUpdatePriority,
  resolveUpdatePriority: () => currentUpdatePriority || DEFAULT_EVENT_PRIORITY,

  // transition / suspense host hooks (0.31+)
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  requestPostPaintCallback: () => {},
  maySuspendCommit: () => false,
  startSuspendingCommit: () => {},
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: createContext(null),

  // misc no-ops required by the type/runtime
  detachDeletedInstance: () => {},
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
  getInstanceFromNode: () => null,
  preparePortalMount: () => {},
};

/** The subset of the reconciler instance we drive from the runtime. */
interface TerminalReconciler {
  createContainer(...args: unknown[]): unknown;
  updateContainer(element: unknown, container: unknown, parent: unknown, callback: unknown): void;
  /** Synchronous-root update + flush pair (react-reconciler 0.31+); together
   * they force a commit so a test can read the frame immediately. */
  updateContainerSync(
    element: unknown,
    container: unknown,
    parent: unknown,
    callback: unknown,
  ): void;
  flushSyncWork(): void;
}

// react-reconciler's HostConfig carries ~17 generic params; our nodes are
// typed precisely above, so we bridge the factory call with a single cast
// rather than enumerating every generic. Tightened in P6.
export const reconciler = (
  ReactReconciler as unknown as (config: typeof hostConfig) => TerminalReconciler
)(hostConfig);

/** react-reconciler RootTag for a concurrent root. */
export const CONCURRENT_ROOT = 1;
