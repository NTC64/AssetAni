import { definePanel } from '../cocos/cocos-3.8-adapter';
import type { OperationSnapshot } from '../shared/generation';
import {
  requestApiKey,
  requestGenerationProgress,
  requestRetryGeneration,
  requestStartGeneration,
  requestStartCharacterBatch,
} from './bridge';

interface PanelContext {
  $: {
    backend: HTMLInputElement;
    apiKey: HTMLInputElement;
    prompt: HTMLTextAreaElement;
    characterName: HTMLInputElement;
    preset: HTMLSelectElement;
    animation: HTMLSelectElement;
    fps: HTMLInputElement;
    generate: HTMLButtonElement;
    batch: HTMLButtonElement;
    retry: HTMLButtonElement;
    progress: HTMLProgressElement;
    status: HTMLElement;
    detail: HTMLElement;
  };
  pollTimer?: ReturnType<typeof setInterval>;
}

function isTerminal(snapshot: OperationSnapshot) {
  return snapshot.state !== 'RUNNING';
}

function render(context: PanelContext, snapshot: OperationSnapshot) {
  const running = snapshot.state === 'RUNNING';
  context.$.backend.disabled = running;
  context.$.apiKey.disabled = running;
  context.$.prompt.disabled = running;
  context.$.characterName.disabled = running;
  context.$.preset.disabled = running;
  context.$.animation.disabled = running;
  context.$.fps.disabled = running;
  context.$.generate.disabled = running;
  context.$.batch.disabled = running;
  context.$.retry.hidden = !snapshot.canRetry;
  context.$.retry.disabled = running;
  context.$.progress.value = snapshot.progress;
  context.$.progress.setAttribute('aria-valuetext', snapshot.message);
  context.$.status.textContent = snapshot.message;
  context.$.status.dataset.state = snapshot.state.toLowerCase();
  context.$.detail.textContent = snapshot.generationId
    ? `Generation: ${snapshot.generationId}${snapshot.animationUrl ? `\nAnimation: ${snapshot.animationUrl}` : ''}${snapshot.creditsRemaining !== undefined ? `\nCredits remaining: ${snapshot.creditsRemaining}` : ''}`
    : snapshot.animationUrls?.length
      ? snapshot.animationUrls.join('\n')
      : '';
}

function stopPolling(context: PanelContext) {
  if (context.pollTimer !== undefined) clearInterval(context.pollTimer);
  context.pollTimer = undefined;
}

async function refreshProgress(context: PanelContext) {
  try {
    const snapshot = await requestGenerationProgress();
    render(context, snapshot);
    if (isTerminal(snapshot)) stopPolling(context);
  } catch {
    stopPolling(context);
    context.$.status.dataset.state = 'failed';
    context.$.status.textContent =
      'Unable to reach the extension. Reload it in Extension Manager and retry.';
    context.$.generate.disabled = false;
  }
}

function startPolling(context: PanelContext) {
  stopPolling(context);
  context.pollTimer = setInterval(() => {
    void refreshProgress(context);
  }, 400);
}

export = definePanel({
  template: `<section>
    <header>
      <h2>AI Sprite Generator</h2>
      <p>Generate, download, and import an animation without leaving Cocos Creator.</p>
    </header>
    <label>Backend URL
      <input id="backend" type="url" value="http://localhost:3000" spellcheck="false">
    </label>
    <label>API key
      <input id="api-key" type="password" placeholder="spr_live_…" autocomplete="off" spellcheck="false">
    </label>
    <label>Character prompt
      <textarea id="prompt" maxlength="800" rows="5" placeholder="Blue knight with a silver sword" required></textarea>
    </label>
    <div class="row">
      <label>Character name
        <input id="character-name" maxlength="80" value="Knight">
      </label>
      <label>Game preset
        <select id="preset">
          <option value="platformer">Platformer</option>
          <option value="side_scroller">Side scroller</option>
          <option value="top_down_rpg">Top-down RPG</option>
        </select>
      </label>
    </div>
    <div class="row">
      <label>Animation
        <select id="animation">
          <option value="walk">Walk</option>
          <option value="idle">Idle</option>
          <option value="attack">Attack</option>
          <option value="run">Run</option>
          <option value="hurt">Hurt</option>
          <option value="death">Death</option>
        </select>
      </label>
      <label>FPS
        <input id="fps" type="number" min="4" max="30" step="1" value="12">
      </label>
      <label>Frames
        <input type="number" value="8" disabled>
      </label>
    </div>
    <div class="actions">
      <button id="generate">Generate and Import</button>
      <button id="batch" class="secondary">Create Character + 6 Animations</button>
      <button id="retry" class="secondary" hidden>Retry</button>
    </div>
    <progress id="progress" max="100" value="0" aria-label="Generation progress"></progress>
    <p id="status" role="status" aria-live="polite" data-state="idle">Ready to generate.</p>
    <pre id="detail"></pre>
  </section>`,
  style: `
    section { padding: 16px; font: 13px/1.45 sans-serif; color: var(--color-normal-contrast, #ddd); }
    header { margin-bottom: 16px; }
    h2 { margin: 0 0 4px; font-size: 18px; }
    header p { margin: 0; color: var(--color-normal-contrast-weakest, #aaa); }
    label { display: block; margin: 11px 0; }
    input, select, textarea { display: block; box-sizing: border-box; width: 100%; margin-top: 4px; }
    textarea { min-height: 82px; resize: vertical; }
    .row { display: grid; grid-template-columns: 1.5fr .8fr .8fr; gap: 10px; }
    .actions { display: flex; gap: 8px; margin: 16px 0 12px; }
    button { min-height: 32px; padding: 6px 14px; }
    button.secondary { opacity: .9; }
    progress { width: 100%; height: 10px; }
    #status { margin: 8px 0 0; overflow-wrap: anywhere; }
    #status[data-state="succeeded"] { color: #72d58c; }
    #status[data-state="failed"] { color: #ff8a8a; }
    #detail { margin: 7px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--color-normal-contrast-weakest, #aaa); font: 11px/1.45 monospace; }
  `,
  $: {
    backend: '#backend',
    apiKey: '#api-key',
    prompt: '#prompt',
    characterName: '#character-name',
    preset: '#preset',
    animation: '#animation',
    fps: '#fps',
    generate: '#generate',
    batch: '#batch',
    retry: '#retry',
    progress: '#progress',
    status: '#status',
    detail: '#detail',
  },
  ready(this: PanelContext) {
    this.$.generate.onclick = async () => {
      const prompt = this.$.prompt.value.trim();
      const fps = Number(this.$.fps.value);
      if (!prompt) {
        this.$.status.dataset.state = 'failed';
        this.$.status.textContent = 'Enter a character prompt first.';
        this.$.prompt.focus();
        return;
      }
      try {
        const snapshot = await requestStartGeneration({
          backendUrl: this.$.backend.value.trim(),
          apiKey: this.$.apiKey.value.trim(),
          prompt,
          style: 'pixel_art',
          animation: this.$.animation.value as
            | 'idle'
            | 'walk'
            | 'run'
            | 'attack'
            | 'hurt'
            | 'death',
          direction: 'right',
          frameCount: 8,
          fps,
          frameSize: 256,
          background: 'transparent',
          seed: null,
        });
        render(this, snapshot);
        if (!isTerminal(snapshot)) startPolling(this);
      } catch {
        this.$.status.dataset.state = 'failed';
        this.$.status.textContent =
          'Check the API key, backend URL, prompt, and FPS (4–30), then retry.';
      }
    };
    this.$.batch.onclick = async () => {
      const prompt = this.$.prompt.value.trim();
      const name = this.$.characterName.value.trim();
      if (!prompt || !name) {
        this.$.status.dataset.state = 'failed';
        this.$.status.textContent = 'Enter a character name and prompt first.';
        return;
      }
      try {
        const next = await requestStartCharacterBatch({
          backendUrl: this.$.backend.value.trim(),
          apiKey: this.$.apiKey.value.trim(),
          name,
          prompt,
          preset: this.$.preset.value as
            | 'platformer'
            | 'side_scroller'
            | 'top_down_rpg',
          animations: ['idle', 'walk', 'run', 'attack', 'hurt', 'death'],
          mode: 'standard',
        });
        render(this, next);
        if (!isTerminal(next)) startPolling(this);
      } catch {
        this.$.status.dataset.state = 'failed';
        this.$.status.textContent =
          'Check the character fields, API key, and backend, then retry.';
      }
    };
    this.$.retry.onclick = async () => {
      try {
        const snapshot = await requestRetryGeneration();
        render(this, snapshot);
        if (!isTerminal(snapshot)) startPolling(this);
      } catch {
        this.$.status.dataset.state = 'failed';
        this.$.status.textContent =
          'Unable to retry. Reload the extension and try again.';
      }
    };
    void requestApiKey()
      .then((saved) => {
        this.$.apiKey.value = saved.apiKey;
      })
      .catch(() => undefined);
    void refreshProgress(this).then(() => {
      if (this.$.generate.disabled) startPolling(this);
    });
  },
  close(this: PanelContext) {
    stopPolling(this);
    this.$.generate.onclick = null;
    this.$.batch.onclick = null;
    this.$.retry.onclick = null;
  },
});
