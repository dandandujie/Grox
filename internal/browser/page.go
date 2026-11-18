package browser

const inspectExpression = `(sequence) => {
  const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible";
  const label = (node) => (node.getAttribute("aria-label") || node.labels?.[0]?.innerText ||
    node.innerText || node.getAttribute("placeholder") || node.getAttribute("title") ||
    node.getAttribute("name") || node.tagName).trim().replace(/\s+/g, " ").slice(0, 160);
  const signature = (node) => JSON.stringify([label(node), node.getAttribute("href"), node.getAttribute("type"),
    node.getAttribute("role"), node.form?.action, node.form?.method, node.getAttribute("formaction"),
    node.getAttribute("formmethod"), node.getAttribute("target"), node.getAttribute("download"),
    node.form?.target, node.getAttribute("formtarget")]);
  globalThis.groxBrowser = { location: location.href, elements: new Map(), signature, visible };
  const elements = [];
  for (const node of document.querySelectorAll("a[href],button,input:not([type=hidden]),textarea,[role=button]")) {
    if (elements.length >= 48) break;
    if (!visible(node) || node.disabled || node.matches('input[type="password"],input[type="file"],a[download]')) continue;
    if (node instanceof HTMLAnchorElement && (!/^https?:$/.test(node.protocol) ||
        (node.target && !["_self", "_top", "_parent"].includes(node.target.toLowerCase())))) continue;
    const ref = "e" + sequence + "-" + (elements.length + 1);
    globalThis.groxBrowser.elements.set(ref, { node, signature: signature(node) });
    elements.push({ ref, tag: node.tagName.toLowerCase(), label: label(node), href: node.href || "" });
  }
  return { url: location.href, title: document.title.slice(0, 160),
    text: (document.body?.innerText || "").slice(0, 7000), elements };
}`

const actExpression = `(action, ref, text) => {
  const state = globalThis.groxBrowser;
  const entry = state?.elements.get(ref);
  if (!entry || location.href !== state.location || !entry.node.isConnected || entry.node.ownerDocument !== document ||
      !state.visible(entry.node) || entry.node.disabled || state.signature(entry.node) !== entry.signature) {
    return "The inspected page or element changed. Inspect it again.";
  }
  const node = entry.node;
  if (node.matches('input[type="password"], input[type="file"]')) return "This input is unavailable.";
  if (action === "click") {
    node.click();
    return "";
  }
  const editable = node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLInputElement && ["text", "search", "email", "url", "tel", "number"].includes(node.type));
  if (!editable || node.readOnly) return "That element is not an editable text field.";
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, text);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
  return "";
}`
