// Nova LiveOS DOM patcher — v1.0.5
// In-place reconciliation used by the shell's render(): instead of
// replacing #app's innerHTML wholesale (which visibly blinked on every
// background refresh — scroll jumped, inputs lost focus and content,
// counters re-animated), the freshly rendered view is built in a
// <template> and reconciled against the live DOM node by node.
//
// Nodes whose tag and position still line up are PATCHED, never
// replaced: attributes are synced, text is updated only when it
// changed, children are reconciled recursively, new nodes are inserted
// and vanished ones removed. A subtree whose markup is unchanged is
// not touched at all — so scroll position, focus, caret, typed input
// content and drag state survive a background refresh, and a real
// change from another shell lands as an in-place insertion/update
// (a chat message appends, a kanban card's column updates, a stat
// number changes) instead of a screen blink.
//
// Extra care: the element the user is currently typing in never has
// its value attribute rewritten by a patch.

function syncAttributes(cur, nxt) {
  const typing = cur === document.activeElement &&
    (cur.tagName === "INPUT" || cur.tagName === "TEXTAREA" || cur.tagName === "SELECT");
  for (const attr of [...cur.attributes]) {
    if (!nxt.hasAttribute(attr.name)) cur.removeAttribute(attr.name);
  }
  for (const attr of nxt.attributes) {
    if (typing && attr.name === "value") continue;
    if (cur.getAttribute(attr.name) !== attr.value) cur.setAttribute(attr.name, attr.value);
  }
}

export function patchChildren(curParent, nxtParent) {
  const curKids = [...curParent.childNodes];
  const nxtKids = [...nxtParent.childNodes];
  const len = Math.max(curKids.length, nxtKids.length);
  for (let i = 0; i < len; i++) {
    const cur = curKids[i];
    const nxt = nxtKids[i];
    if (!nxt) { cur.remove(); continue; }
    if (!cur) { curParent.appendChild(nxt); continue; }
    if (cur.nodeType !== nxt.nodeType || cur.nodeName !== nxt.nodeName) {
      cur.replaceWith(nxt);
      continue;
    }
    if (cur.nodeType === 3) { // text node: update only on change
      if (cur.textContent !== nxt.textContent) cur.textContent = nxt.textContent;
      continue;
    }
    if (cur.nodeType === 1) { // element: patch in place
      syncAttributes(cur, nxt);
      patchChildren(cur, nxt);
    }
    // comments and other node types are left as-is
  }
}
