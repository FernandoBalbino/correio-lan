export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function icon(name, width = 22, height = width) {
  const img = document.createElement('img');
  img.src = `/assets/figma/${name}`; img.alt = ''; img.width = width; img.height = height;
  return img;
}
export function toast(title, detail = '', { error = false } = {}) {
  const container = document.querySelector('#toasts');
  const node = el('div', `toast${error ? ' error' : ''}`);
  node.append(el('strong', '', title));
  if (detail) node.append(el('p', '', detail));
  container.append(node);
  while (container.children.length > 4) container.firstChild.remove();
  setTimeout(() => node.remove(), 6500);
}
export function emptyState(container, title, detail, action) {
  const node = el('div', 'empty-state');
  node.append(icon('imgPageInbox.svg', 22), el('h2', '', title), el('p', 'muted', detail));
  if (action) { const button = el('button', 'primary', action.label); button.addEventListener('click', action.run); node.append(button); }
  container.replaceChildren(node);
}
export function dateTime(timestamp) { return new Date(timestamp).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
export function shortTime(timestamp) {
  return new Date(timestamp).toLocaleString('pt-BR', new Date(timestamp).toDateString() === new Date().toDateString()
    ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short' });
}
