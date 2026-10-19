/** 页面右上角的浮标：会话状态的持久视图。popup 关掉后，用户还能看到进度/还原。 */
export class FloatView {
  private el: HTMLElement;
  private textEl: HTMLElement;

  constructor(doc: Document, onClick: () => void) {
    this.el = doc.createElement('div');
    this.el.className = 'gt-float';
    this.el.innerHTML = '<span class="gt-float-dot"></span><span class="gt-float-text">译</span>';
    this.el.title = 'Gemma 整页翻译（本地推理）';
    this.el.addEventListener('click', onClick);
    this.textEl = this.el.querySelector('.gt-float-text') as HTMLElement;
    doc.documentElement.appendChild(this.el);
  }

  set(text: string, busy = false): void {
    this.textEl.textContent = text;
    this.el.dataset.gtBusy = busy ? '1' : '0';
  }

  setHidden(hidden: boolean): void {
    this.el.dataset.gtHidden = hidden ? '1' : '0';
  }

  remove(): void {
    this.el.remove();
  }
}
