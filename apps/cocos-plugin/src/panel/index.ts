import { definePanel, requestTestImport } from '../cocos/cocos-3.8-adapter';

interface PanelContext {
  $: { run: HTMLButtonElement; status: HTMLElement };
}
export = definePanel({
  template: `<section>
    <h2>AI Sprite Generator</h2>
    <p>Phase 1 · Local animation import</p>
    <label>Prompt<textarea disabled placeholder="Available after the local import proof"></textarea></label>
    <label>Animation<select disabled><option>Walk</option><option>Idle</option><option>Attack</option></select></label>
    <label>Frame Count<input type="number" value="8" disabled></label>
    <label>FPS<input type="number" value="12" disabled></label>
    <p>Test Import uses the bundled manifest: walk, 8 frames, 12 FPS. Repeating it replaces the test fixture assets.</p>
    <button id="run">Test Import</button><p id="status" role="status" aria-live="polite">Ready to import into AI_Sprites/test_walk.</p>
  </section>`,
  style: `section {padding:16px;font:13px sans-serif} h2{font-size:18px} label{display:block;margin:10px 0} input,select,textarea{display:block;box-sizing:border-box;width:100%;margin-top:4px} button{padding:8px 16px} #status{line-height:1.5;overflow-wrap:anywhere}`,
  $: { run: '#run', status: '#status' },
  ready(this: PanelContext) {
    this.$.run.onclick = async () => {
      this.$.run.disabled = true;
      this.$.status.textContent =
        'Importing eight frames and creating walk.anim…';
      try {
        this.$.status.textContent = (await requestTestImport()).message;
      } catch {
        this.$.status.textContent =
          'Unable to reach the extension. Reload it in Extension Manager and retry.';
      } finally {
        this.$.run.disabled = false;
      }
    };
  },
  close(this: PanelContext) {
    this.$.run.onclick = null;
  },
});
