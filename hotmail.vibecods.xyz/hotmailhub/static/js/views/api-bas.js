import { h, mount } from '../ui.js';

export function render(root) {
  mount(root, h('p', null, 'TODO'));
}
