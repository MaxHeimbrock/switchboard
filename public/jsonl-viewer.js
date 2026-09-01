// --- JSONL Message History Viewer ---
// Depends on globals: escapeHtml (utils.js), hideAllViewers (plans-memory-view.js),
// placeholder, terminalArea, jsonlViewer, jsonlViewerTitle, jsonlViewerSessionId,
// jsonlViewerBody, restoreMainArea (app.js)
//
// Also the home of conversationText() — the single definition of what a keyword search
// counts and what the transcript's find bar searches. It is required by main.js for the
// sidebar's occurrence badges, so nothing above the function bodies may touch the DOM.

function renderJsonlText(text) {
  if (window.marked) {
    // Escape XML/HTML-like tags so they render as visible text,
    // but preserve markdown code blocks (which may contain HTML examples).
    const escaped = text.replace(/<(\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?)\>/g, '&lt;$1&gt;');
    let html = window.marked.parse(escaped);
    return html;
  }
  // Fallback if marked isn't loaded
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="jsonl-code-block"><code>$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code class="jsonl-inline-code">$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return html;
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = (ms / 1000).toFixed(1);
  return s + 's';
}

function makeInlineContent(className, bodyContent) {
  const wrapper = document.createElement('div');
  wrapper.className = className;
  const body = document.createElement('pre');
  body.className = 'jsonl-tool-body';
  body.style.display = '';
  if (typeof bodyContent === 'string') {
    body.textContent = bodyContent;
  } else {
    try { body.textContent = JSON.stringify(bodyContent, null, 2); } catch { body.textContent = String(bodyContent); }
  }
  wrapper.appendChild(body);
  return wrapper;
}

function makeCollapsible(className, headerText, bodyContent, startExpanded) {
  const wrapper = document.createElement('div');
  wrapper.className = className;
  const header = document.createElement('div');
  header.className = 'jsonl-toggle' + (startExpanded ? ' expanded' : '');
  header.textContent = headerText;
  const body = document.createElement('pre');
  body.className = 'jsonl-tool-body';
  body.style.display = startExpanded ? '' : 'none';
  if (typeof bodyContent === 'string') {
    body.textContent = bodyContent;
  } else {
    try { body.textContent = JSON.stringify(bodyContent, null, 2); } catch { body.textContent = String(bodyContent); }
  }
  header.onclick = () => {
    const showing = body.style.display !== 'none';
    body.style.display = showing ? 'none' : '';
    header.classList.toggle('expanded', !showing);
  };
  wrapper.appendChild(header);
  wrapper.appendChild(body);
  return wrapper;
}

// --- Tool use rendering ---
// Renders tool calls in a bullet + indented content style matching Claude Code's terminal.

function toolBlock(color, label, summary, content) {
  const el = document.createElement('div');
  el.className = 'jsonl-tool-block';
  const header = document.createElement('div');
  header.className = 'jsonl-tool-header';
  header.innerHTML = '<span class="jsonl-tool-bullet" style="color:' + color + '">●</span>'
    + '<span class="jsonl-tool-name">' + escapeHtml(label) + '</span>'
    + (summary ? '<span class="jsonl-tool-summary">' + summary + '</span>' : '');
  el.appendChild(header);
  if (content) {
    const body = document.createElement('div');
    body.className = 'jsonl-tool-content';
    if (typeof content === 'string') {
      body.innerHTML = content;
    } else {
      body.appendChild(content);
    }
    el.appendChild(body);
  }
  return el;
}

function renderToolUse(block) {
  const name = block.name || 'unknown';
  const input = block.input || {};
  const renderer = toolRenderers[name];
  if (renderer) {
    try { return renderer(input, block); } catch {}
  }
  // MCP / computer-use tools with an action field
  if (input.action) {
    try { return renderMcpAction(name, input, block); } catch {}
  }
  // Default: collapsible JSON
  return toolBlock('#8888a0', name, '', makeCollapsible('jsonl-tool-result', 'Input', input, true));
}

function renderMcpAction(name, input, block) {
  const action = input.action;
  // Short display name: strip mcp__ prefix, take last segment
  const shortName = name.replace(/^mcp__/, '').split('__').pop();
  const actionLabels = {
    type: 'Type',
    screenshot: 'Screenshot',
    click: 'Click',
    scroll: 'Scroll',
    hover: 'Hover',
    drag: 'Drag',
    key: 'Key',
    wait: 'Wait',
    javascript_exec: 'JS Exec',
    navigate: 'Navigate',
  };
  const label = actionLabels[action] || action;
  let summary = '<span class="jsonl-tool-detail">' + escapeHtml(shortName) + '</span>';
  let content = null;

  if (action === 'type' && input.text) {
    summary += ' <code>' + escapeHtml(input.text.length > 80 ? input.text.slice(0, 80) + '...' : input.text) + '</code>';
  } else if (action === 'click' && (input.x != null || input.selector)) {
    const target = input.selector || `(${input.x}, ${input.y})`;
    summary += ' <code>' + escapeHtml(target) + '</code>';
  } else if (action === 'key' && input.key) {
    summary += ' <code>' + escapeHtml(input.key) + '</code>';
  } else if (action === 'navigate' && input.url) {
    summary += ' <code>' + escapeHtml(input.url.length > 80 ? input.url.slice(0, 80) + '...' : input.url) + '</code>';
  } else if (action === 'scroll') {
    const dir = input.direction || (input.deltaY > 0 ? 'down' : 'up');
    summary += ' <span class="jsonl-tool-detail">' + escapeHtml(dir) + '</span>';
  } else if (action === 'javascript_exec' && input.text) {
    const pre = document.createElement('pre');
    pre.className = 'jsonl-tool-cmd-block';
    pre.textContent = input.text;
    content = pre;
  }

  return toolBlock('#c090e0', label, summary, content);
}

function shortPath(p) {
  return (p || '').split('/').slice(-3).join('/');
}

const toolRenderers = {
  Read(input) {
    const path = input.file_path || '';
    let range = '';
    if (input.offset || input.limit) {
      const start = input.offset || 0;
      range = input.limit ? `:${start}-${start + input.limit}` : `:${start}`;
    }
    return toolBlock('#8888a0', 'Read', '<code>' + escapeHtml(shortPath(path) + range) + '</code>', null);
  },

  Edit(input) {
    const path = input.file_path || '';
    let content = null;
    if (input.old_string != null && input.new_string != null) {
      const diff = document.createElement('pre');
      diff.className = 'jsonl-tool-diff';
      let html = '';
      for (const line of input.old_string.split('\n')) {
        html += '<span class="jsonl-diff-del">- ' + escapeHtml(line) + '</span>\n';
      }
      for (const line of input.new_string.split('\n')) {
        html += '<span class="jsonl-diff-add">+ ' + escapeHtml(line) + '</span>\n';
      }
      diff.innerHTML = html;
      content = diff;
    }
    return toolBlock('#e0a040', 'Edit', '<code>' + escapeHtml(shortPath(path)) + '</code>', content);
  },

  Write(input) {
    const path = input.file_path || '';
    const lines = (input.content || '').split('\n').length;
    const detail = '<code>' + escapeHtml(shortPath(path)) + '</code> <span class="jsonl-tool-detail">' + lines + ' lines</span>';
    let content = null;
    if (input.content) {
      content = makeCollapsible('jsonl-tool-result', 'Content', input.content, true);
    }
    return toolBlock('#60c060', 'Write', detail, content);
  },

  Bash(input) {
    const cmd = input.command || '';
    const pre = document.createElement('pre');
    pre.className = 'jsonl-tool-cmd-block';
    pre.textContent = cmd;
    return toolBlock('#80c0e0', 'Bash', null, pre);
  },

  Grep(input) {
    const pattern = input.pattern || '';
    const path = input.path || '';
    const sp = path ? shortPath(path) : '';
    const summary = '<code>' + escapeHtml(pattern) + (sp ? ' in ' + escapeHtml(sp) : '') + '</code>';
    return toolBlock('#c090e0', 'Grep', summary, null);
  },

  Glob(input) {
    const pattern = input.pattern || '';
    return toolBlock('#c090e0', 'Glob', '<code>' + escapeHtml(pattern) + '</code>', null);
  },

  Agent(input) {
    const desc = input.description || '';
    const type = input.subagent_type || '';
    const summary = (type ? '<span class="jsonl-tool-detail">' + escapeHtml(type) + '</span> ' : '')
      + escapeHtml(desc);
    return toolBlock('#f0a050', 'Agent', summary, null);
  },
};

// Render a local command (! prefix) as a tool block
function renderLocalCommand({ cmd, output }) {
  const pre = document.createElement('pre');
  pre.className = 'jsonl-tool-cmd-block';
  pre.textContent = cmd;

  const el = toolBlock('#80c0e0', 'Bash', '<span class="jsonl-tool-detail">local</span>', pre);

  if (output) {
    let contentEl = el.querySelector('.jsonl-tool-content');
    if (!contentEl) {
      contentEl = document.createElement('div');
      contentEl.className = 'jsonl-tool-content';
      el.appendChild(contentEl);
    }
    const resultPre = document.createElement('pre');
    resultPre.className = 'jsonl-tool-cmd-block';
    resultPre.textContent = output;
    contentEl.appendChild(resultPre);
  }

  return el;
}

// Merge consecutive local command entries (separate JSONL entries for caveat, bash-input, stdout/stderr)
//
// Returns [{ entry, from, to, open }] — `from`/`to` are the half-open range of raw
// indices the element was built from, which is what lets an incremental re-render map
// a DOM node back to the raw entries behind it. A synthetic local-command entry spans
// its whole group; everything else spans one entry.
//
// `open` marks an element built from a group that ran to the end of the list without
// its closing </bash-stdout> — the other process is still writing it, so what it
// renders as will change. That is the one thing a caller cannot work out from the
// result, because a group becomes synthetic as soon as <bash-input> closes, well
// before its output arrives.
function mergeLocalCommandEntries(entries) {
  const result = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    const text = getEntryText(entry);

    // Look for a local-command-caveat or bash-input entry
    if (text && (/<local-command-caveat>/.test(text) || /<bash-input>/.test(text))) {
      // Gather consecutive entries that are part of this local command
      let combined = '';
      const start = i;
      let terminated = false;
      while (i < entries.length) {
        const t = getEntryText(entries[i]);
        if (!t) break;
        // Stop if we hit a non-local-command entry (no XML tags we recognize)
        if (i > start && !/<bash-input>|<bash-stdout>|<bash-stderr>|<local-command-caveat>/.test(t)) break;
        combined += t + '\n';
        i++;
        // Stop after we've seen stdout or stderr (end of command)
        if (/<\/bash-stdout>|<\/bash-stderr>/.test(t)) { terminated = true; break; }
      }
      // Ended only because the file ended: the next append may extend this group.
      // A run stopped by an entry that follows it is bounded, however it ended.
      const open = !terminated && i === entries.length;

      const inputMatch = combined.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
      if (inputMatch) {
        const cmd = inputMatch[1].trim();
        const stdoutMatch = combined.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
        const stderrMatch = combined.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
        const stdout = stdoutMatch ? stdoutMatch[1].trim() : '';
        const stderr = stderrMatch ? stderrMatch[1].trim() : '';
        const output = [stdout, stderr].filter(Boolean).join('\n');
        // Create a synthetic entry
        result.push({ entry: { _localCmd: { cmd, output }, type: 'local-command' }, from: start, to: i, open });
      } else {
        // Couldn't parse, keep original entries
        for (let j = start; j < i; j++) result.push({ entry: entries[j], from: j, to: j + 1, open });
      }
    } else {
      result.push({ entry, from: i, to: i + 1, open: false });
      i++;
    }
  }
  return result;
}

// How far back an unresolved tool call is still considered live. Beyond it, a call
// that never got a result is treated as abandoned rather than pinning the boundary
// at that entry for the rest of the session.
const UNSETTLED_TOOL_WINDOW = 50;

// The lowest raw index whose rendering can still change as more entries arrive —
// the boundary an incremental re-render starts from. Everything below it is final
// and keeps its DOM, and with it its expand/collapse state. `rawLen` when nothing
// is unsettled.
function computeSafeFrom(merged, resultIds, rawLen) {
  let safeFrom = rawLen;

  // (a) A local-command group the other process is still writing: its output, and
  // whether it renders as a command block at all, both change as entries land.
  for (const el of merged) {
    if (el.open) safeFrom = Math.min(safeFrom, el.from);
  }

  // (b) A tool_use whose result has not arrived yet: the result renders inside the
  // call's own block, so the call has to be re-rendered when it lands.
  const windowStart = Math.max(0, merged.length - UNSETTLED_TOOL_WINDOW);
  for (let i = windowStart; i < merged.length; i++) {
    const el = merged[i];
    const blocks = el.entry.message?.content || el.entry.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id && !resultIds.has(block.id)) {
        safeFrom = Math.min(safeFrom, el.from);
        break;
      }
    }
  }

  return safeFrom;
}

function getEntryText(entry) {
  if (!entry) return null;
  const content = entry.message?.content || entry.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return null;
}

// Merge local command blocks within a single entry's text blocks
function mergeLocalCommandBlocks(blocks) {
  // Check if any text block contains <bash-input>
  const hasLocalCmd = blocks.some(b => b.type === 'text' && b.text && /<bash-input>/.test(b.text));
  if (!hasLocalCmd) return blocks;

  // Concatenate all text blocks to find the full command structure
  let combined = '';
  for (const b of blocks) {
    if (b.type === 'text' && b.text) combined += b.text + '\n';
  }

  const inputMatch = combined.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  if (!inputMatch) return blocks;

  const cmd = inputMatch[1].trim();
  const stdoutMatch = combined.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
  const stderrMatch = combined.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
  const stdout = stdoutMatch ? stdoutMatch[1].trim() : '';
  const stderr = stderrMatch ? stderrMatch[1].trim() : '';
  const output = [stdout, stderr].filter(Boolean).join('\n');

  // Replace all text blocks with a single merged one
  const merged = { type: 'text', text: combined, _localCmd: { cmd, output } };
  const result = [];
  let replacedText = false;
  for (const b of blocks) {
    if (b.type === 'text') {
      if (!replacedText) {
        result.push(merged);
        replacedText = true;
      }
      // skip other text blocks
    } else {
      result.push(b);
    }
  }
  return result;
}

// Render a tool result into a container, handling images, text, and mixed content
function renderToolResult(resultData, container) {
  // Try to extract image data from the result
  const images = extractImages(resultData);
  const textParts = extractResultText(resultData);

  if (textParts) {
    container.appendChild(makeInlineContent('jsonl-tool-result', textParts));
  }
  for (const img of images) {
    const imgEl = document.createElement('img');
    imgEl.className = 'jsonl-tool-screenshot';
    imgEl.src = img.src;
    if (img.alt) imgEl.alt = img.alt;
    imgEl.onclick = () => {
      const overlay = document.createElement('div');
      overlay.className = 'jsonl-screenshot-fullscreen';
      const fullImg = document.createElement('img');
      fullImg.src = img.src;
      overlay.appendChild(fullImg);
      overlay.onclick = () => overlay.remove();
      document.body.appendChild(overlay);
    };
    container.appendChild(imgEl);
  }
}

function extractImages(data) {
  const images = [];
  if (!data) return images;

  // String result — may contain JSON with image data
  if (typeof data === 'string') {
    // Look for {"type":"image","source":... } JSON in the string
    const imgMatches = data.matchAll(/\{"type"\s*:\s*"image"\s*,\s*"source"\s*:\s*\{[^}]*"data"\s*:\s*"([^"]+)"[^}]*\}/g);
    for (const m of imgMatches) {
      const base64 = m[1];
      // Detect media type from the JSON or default to jpeg
      const mediaMatch = m[0].match(/"media_type"\s*:\s*"([^"]+)"/);
      const mediaType = mediaMatch ? mediaMatch[1] : 'image/jpeg';
      images.push({ src: `data:${mediaType};base64,${base64}` });
    }
    return images;
  }

  // Array of content blocks
  if (Array.isArray(data)) {
    for (const block of data) {
      if (block.type === 'image' && block.source?.data) {
        const mediaType = block.source.media_type || 'image/jpeg';
        images.push({ src: `data:${mediaType};base64,${block.source.data}` });
      }
    }
  }
  return images;
}

function extractResultText(data) {
  if (!data) return null;
  if (typeof data === 'string') {
    // Strip the image JSON blobs from the display text
    const cleaned = data.replace(/\{"type"\s*:\s*"image"\s*,\s*"source"\s*:\s*\{[^}]*\}\s*\}/g, '').trim();
    return cleaned || null;
  }
  if (Array.isArray(data)) {
    const texts = data.filter(b => b.type === 'text' || b.text).map(b => b.text || JSON.stringify(b));
    return texts.length ? texts.join('\n') : null;
  }
  return JSON.stringify(data, null, 2);
}

function renderJsonlEntry(entry, toolResultMap) {
  // Synthetic local command entry from mergeLocalCommandEntries
  if (entry._localCmd) {
    return renderLocalCommand(entry._localCmd);
  }

  const ts = entry.timestamp;
  const timeStr = ts ? new Date(ts).toLocaleTimeString() : '';

  // --- custom-title ---
  if (entry.type === 'custom-title') {
    const div = document.createElement('div');
    div.className = 'jsonl-entry jsonl-meta-entry';
    div.innerHTML = '<span class="jsonl-meta-icon">T</span> Title set: <strong>' + escapeHtml(entry.customTitle || '') + '</strong>';
    return div;
  }

  // --- system entries ---
  if (entry.type === 'system') {
    const div = document.createElement('div');
    div.className = 'jsonl-entry jsonl-meta-entry';
    if (entry.subtype === 'turn_duration') {
      div.innerHTML = '<span class="jsonl-meta-icon">&#9201;</span> Turn duration: <strong>' + formatDuration(entry.durationMs) + '</strong>'
        + (timeStr ? ' <span class="jsonl-ts">' + timeStr + '</span>' : '');
    } else if (entry.subtype === 'local_command') {
      const cmdMatch = (entry.content || '').match(/<command-name>(.*?)<\/command-name>/);
      const cmd = cmdMatch ? cmdMatch[1] : entry.content || 'unknown';
      div.innerHTML = '<span class="jsonl-meta-icon">$</span> Command: <code class="jsonl-inline-code">' + escapeHtml(cmd) + '</code>'
        + (timeStr ? ' <span class="jsonl-ts">' + timeStr + '</span>' : '');
    } else {
      return null;
    }
    return div;
  }

  // --- progress entries ---
  if (entry.type === 'progress') {
    const data = entry.data;
    if (!data || typeof data !== 'object') return null;
    const dt = data.type;
    if (dt === 'bash_progress') {
      const div = document.createElement('div');
      div.className = 'jsonl-entry jsonl-meta-entry';
      const elapsed = data.elapsedTimeSeconds ? ` (${data.elapsedTimeSeconds}s, ${data.totalLines || 0} lines)` : '';
      div.innerHTML = '<span class="jsonl-meta-icon">&#9658;</span> Bash output' + escapeHtml(elapsed);
      if (data.output || data.fullOutput) {
        const output = data.fullOutput || data.output || '';
        div.appendChild(makeCollapsible('jsonl-tool-result', 'Output', output, true));
      }
      return div;
    }
    // Skip noisy progress types
    return null;
  }

  // --- user / assistant messages ---
  let role = null;
  let contentBlocks = null;

  if (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user')) {
    role = 'user';
    contentBlocks = entry.message?.content || entry.content;
  } else if (entry.type === 'assistant' || (entry.type === 'message' && entry.role === 'assistant')) {
    role = 'assistant';
    contentBlocks = entry.message?.content || entry.content;
  } else {
    return null;
  }

  if (!contentBlocks) return null;
  if (typeof contentBlocks === 'string') {
    contentBlocks = [{ type: 'text', text: contentBlocks }];
  }
  if (!Array.isArray(contentBlocks)) return null;

  // Detect local command execution across multiple text blocks and merge
  contentBlocks = mergeLocalCommandBlocks(contentBlocks);

  // User messages that are purely tool results get assistant styling
  const isToolResultOnly = role === 'user' && Array.isArray(contentBlocks) &&
    contentBlocks.every(b => b.type === 'tool_result');
  const visualRole = isToolResultOnly ? 'assistant' : role;

  const div = document.createElement('div');
  div.className = 'jsonl-entry ' + (visualRole === 'user' ? 'jsonl-user' : 'jsonl-assistant');


  for (const block of contentBlocks) {
    if (block.type === 'thinking' && block.thinking) {
      div.appendChild(makeCollapsible('jsonl-thinking', 'Thinking', block.thinking, false));
    } else if (block.type === 'text' && block.text && block.text.trim()) {
      // Render merged local command as a tool block
      if (block._localCmd) {
        div.appendChild(renderLocalCommand(block._localCmd));
        continue;
      }
      // Render [Image: source: /path] as an inline image if the entire block is just that
      const imgMatch = block.text.trim().match(/^\[Image:\s*source:\s*([^\]]+)\]$/);
      if (imgMatch) {
        const imgEl = document.createElement('img');
        imgEl.className = 'jsonl-tool-screenshot jsonl-clickable-img';
        imgEl.src = 'file://' + imgMatch[1].trim();
        div.appendChild(imgEl);
        continue;
      }
      const textEl = document.createElement('div');
      textEl.className = 'jsonl-text';
      textEl.innerHTML = renderJsonlText(block.text.trim());
      div.appendChild(textEl);
    } else if (block.type === 'tool_use') {
      const toolEl = renderToolUse(block);
      // Attach matched tool result into the tool block's content area
      if (block.id && toolResultMap && toolResultMap.has(block.id)) {
        const resultData = toolResultMap.get(block.id);
        toolResultMap.delete(block.id); // mark as claimed
        let contentEl = toolEl.querySelector('.jsonl-tool-content');
        if (!contentEl) {
          contentEl = document.createElement('div');
          contentEl.className = 'jsonl-tool-content';
          toolEl.appendChild(contentEl);
        }
        renderToolResult(resultData, contentEl);
      }
      div.appendChild(toolEl);
    } else if (block.type === 'tool_result') {
      // Skip if already claimed by a tool_use above
      if (block.tool_use_id && toolResultMap && !toolResultMap.has(block.tool_use_id)) continue;
      const resultContent = block.content || block.output || '';
      div.appendChild(makeCollapsible('jsonl-tool-result',
        'Tool Result',
        resultContent,
        false));
    }
  }

  // Skip entries with no visible content
  if (!div.children.length) return null;

  return div;
}

// The text the transcript view renders as conversation, as one string. This is the
// single definition of "what a keyword search counts", and it deliberately mirrors the
// `.jsonl-text` branch of renderJsonlEntry above — kept beside it so the two stay in
// step. Anything that branch renders as something else (Thinking, tool calls, tool
// results, inline images, meta entries) is not conversation and is not counted, so no
// hit ever lands inside a collapsed block the reader would have to expand to see.
function conversationText(entries) {
  const parts = [];
  for (const el of mergeLocalCommandEntries(entries)) {
    const entry = el.entry;
    // A local command renders as a Bash tool block, not as a message.
    if (entry._localCmd) continue;

    const isUser = entry.type === 'user' || (entry.type === 'message' && entry.role === 'user');
    const isAssistant = entry.type === 'assistant' || (entry.type === 'message' && entry.role === 'assistant');
    if (!isUser && !isAssistant) continue;

    let contentBlocks = entry.message?.content || entry.content;
    if (!contentBlocks) continue;
    if (typeof contentBlocks === 'string') contentBlocks = [{ type: 'text', text: contentBlocks }];
    if (!Array.isArray(contentBlocks)) continue;

    for (const block of mergeLocalCommandBlocks(contentBlocks)) {
      if (block.type !== 'text' || !block.text || !block.text.trim()) continue;
      if (block._localCmd) continue;
      const text = block.text.trim();
      // Rendered as an <img>, so there is no text on screen to find.
      if (/^\[Image:\s*source:\s*([^\]]+)\]$/.test(text)) continue;
      parts.push(text);
    }
  }
  return parts.join('\n');
}

// Case-insensitive, non-overlapping substring count — the same walk createCMSearchBar's
// findAll does, so a badge and a find bar can never disagree about how many hits a
// piece of text holds.
function countOccurrences(haystack, query) {
  if (!haystack || !query) return 0;
  const hay = haystack.toLowerCase();
  const term = query.toLowerCase();
  let pos = 0;
  let count = 0;
  while ((pos = hay.indexOf(term, pos)) !== -1) {
    count++;
    pos += term.length;
  }
  return count;
}

// --- Live-tailing read-only transcript view ---
//
// The view is read-only in the strong sense: it spawns no PTY and offers no input
// path, so opening it can never collide with the `claude` process that holds the
// session. It follows the .jsonl as that process appends to it.
//
// `nodes` runs parallel to the body's children: [{ from, el }] ascending by `from`,
// so the tail can be dropped by raw index. `gen` invalidates a pass whose session
// was navigated away from while it was awaiting its read.
const jsonlTail = { gen: 0, session: null, cursor: null, raw: [], nodes: [], safeFrom: 0 };

// Passes are serialised: two of them reading the same cursor would each append the
// same entries. A change arriving mid-pass sets `pending` and runs one more.
let jsonlTailBusy = false;
let jsonlTailPending = false;

async function showJsonlViewer(session, opts = {}) {
  hideAllViewers();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  jsonlViewer.style.display = 'flex';

  const displayName = session.name || session.aiTitle || session.summary || session.sessionId;
  jsonlViewerTitle.textContent = displayName;
  jsonlViewerSessionId.textContent = session.sessionId;
  jsonlViewerBody.innerHTML = '';

  // Built here rather than on the first jump, so Cmd+F answers in a transcript that was
  // opened without a search. Focusing the body is what puts the keydown in reach.
  jsonlFindBar();
  jsonlViewerBody.focus({ preventScroll: true });

  const gen = ++jsonlTail.gen;
  jsonlTail.session = session;
  jsonlTail.cursor = null;
  jsonlTail.raw = [];
  jsonlTail.nodes = [];
  jsonlTail.safeFrom = 0;

  await updateJsonlView();
  // Another session was opened while the first render was in flight — its own call
  // owns the watcher now, and installing ours would point it at the wrong file.
  if (gen !== jsonlTail.gen) return;
  // After the first render, so the bar counts the whole transcript rather than whatever
  // that pass happened to have appended by the time it opened.
  if (opts.findQuery) openJsonlFind(opts.findQuery);
  // The poll would get to this within a tick, but the button is on screen now and would
  // read "Resume session" until then.
  setResumeAffordance(jsonlViewerResumeBtn, lockedSessions.has(session.sessionId)
    && !activePtyIds.has(session.sessionId));

  // Watched after the first render, so a change during it is caught by the pass
  // itself rather than arriving before there is anything to reconcile against.
  await window.api.watchSessionTranscript(session.sessionId);
}

function stopJsonlTail() {
  const tailing = jsonlTail.session;
  // The bar belongs to the transcript being left, not to the next one: its query and
  // its marks go with it. Clearing the sidebar search does not come through here.
  jsonlViewer._jsonlFindBar?.close();
  jsonlTail.gen++;
  jsonlTail.session = null;
  jsonlTail.cursor = null;
  jsonlTail.raw = [];
  jsonlTail.nodes = [];
  jsonlTail.safeFrom = 0;
  // Named, so a stop for the transcript we were on cannot take down a watcher a
  // reopen has already installed for another. Skipped entirely when nothing was
  // tailing — hideAllViewers runs on every navigation, tail or no tail.
  if (tailing) window.api.unwatchSessionTranscript(tailing.sessionId);
}

function closeJsonlViewer() {
  stopJsonlTail();
  restoreMainArea();
}

// --- Find bar for the transcript ---
//
// The transcript is DOM, not a CodeMirror document, so it gets its own bar rather than
// reusing createCMSearchBar — but the same markup, the same keys and the same counting
// rule, so the two behave alike. Its scope is deliberately narrow: text nodes inside
// `.jsonl-text` and nothing else, which is exactly what conversationText() counts, so
// the `N` here always equals the badge on the card that was clicked.
//
// The consequence to know about: Cmd+F in a transcript finds nothing inside tool output
// or a Thinking block. That is the agreed scope, not an oversight.
function createJsonlFindBar() {
  const bar = document.createElement('div');
  bar.className = 'terminal-search-bar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Find..." />
    <span class="terminal-search-count"></span>
    <button class="terminal-search-prev" title="Previous (Shift+Enter)">&#x25B2;</button>
    <button class="terminal-search-next" title="Next (Enter)">&#x25BC;</button>
    <button class="terminal-search-close" title="Close (Escape)">&times;</button>
  `;
  // Hung off the header rather than the viewer: the viewer's own top-right corner is
  // where the resume and close buttons live, and the bar would sit on top of them.
  // Absolutely positioned, so it overflows the header downwards without squashing it.
  document.getElementById('jsonl-viewer-header').appendChild(bar);

  const input = bar.querySelector('.terminal-search-input');
  const countEl = bar.querySelector('.terminal-search-count');
  let matches = []; // the <mark> elements, in document order
  let activeIdx = -1;

  // Each mark back to a plain text node, then normalize() so the parent's text is one
  // node again — otherwise a second pass would index the same text in fragments.
  function unmark() {
    for (const mark of jsonlViewerBody.querySelectorAll('mark.jsonl-find-match')) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    }
    matches = [];
  }

  function highlight(query) {
    unmark();
    activeIdx = -1;
    if (!query) { countEl.textContent = ''; return; }

    // Joined with a newline the find input cannot contain, so every hit found in the
    // haystack lies wholly inside one text node and maps back to it unambiguously.
    let haystack = '';
    const index = [];
    for (const textEl of jsonlViewerBody.querySelectorAll('.jsonl-text')) {
      const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue) continue;
        index.push({ node, start: haystack.length });
        haystack += node.nodeValue + '\n';
      }
    }

    const hay = haystack.toLowerCase();
    const term = query.toLowerCase();
    const hits = [];
    let pos = 0;
    while ((pos = hay.indexOf(term, pos)) !== -1) { hits.push(pos); pos += term.length; }
    if (!hits.length) { countEl.textContent = 'No results'; return; }

    // Grouped by node and applied back to front within each, so splitting the text for
    // one hit cannot shift the offsets of the hits before it.
    const byNode = new Map();
    let cursor = 0;
    for (const hit of hits) {
      while (cursor + 1 < index.length && index[cursor + 1].start <= hit) cursor++;
      const entry = index[cursor];
      if (!byNode.has(entry)) byNode.set(entry, []);
      byNode.get(entry).push(hit - entry.start);
    }
    for (const [entry, offsets] of byNode) {
      for (const offset of offsets.slice().reverse()) {
        const hitNode = entry.node.splitText(offset);
        hitNode.splitText(term.length); // leaves hitNode holding exactly the match
        const mark = document.createElement('mark');
        mark.className = 'jsonl-find-match';
        mark.textContent = hitNode.nodeValue;
        hitNode.parentNode.replaceChild(mark, hitNode);
      }
    }

    // Re-read rather than collected as we went: querySelectorAll is in document order,
    // which is the order Enter has to walk them in.
    matches = Array.from(jsonlViewerBody.querySelectorAll('mark.jsonl-find-match'));
    countEl.textContent = `${matches.length} found`;
  }

  function goTo(idx, scroll = true) {
    if (!matches.length) return;
    activeIdx = ((idx % matches.length) + matches.length) % matches.length;
    for (const mark of matches) mark.classList.remove('jsonl-find-match-active');
    const active = matches[activeIdx];
    active.classList.add('jsonl-find-match-active');
    if (scroll) active.scrollIntoView({ block: 'center' });
    countEl.textContent = `${activeIdx + 1} of ${matches.length}`;
  }

  function open(initialQuery) {
    bar.style.display = 'flex';
    if (initialQuery) input.value = initialQuery;
    input.focus();
    input.select();
    highlight(input.value);
    if (matches.length) goTo(0);
  }

  function close() {
    bar.style.display = 'none';
    input.value = '';
    unmark();
    activeIdx = -1;
    countEl.textContent = '';
  }

  // Re-applied after every tail append. The pass re-renders whole entry nodes from the
  // unsettled boundary down, so marks inside them are thrown away with their nodes while
  // marks above survive — rebuilding the lot is the only way to keep `N` and the active
  // index honest. It does not scroll: the pass has already decided whether the view was
  // following the bottom, and a jump here would fight that.
  function refresh() {
    if (bar.style.display === 'none' || !input.value) return;
    const wasActive = activeIdx;
    highlight(input.value);
    if (matches.length) goTo(Math.min(Math.max(wasActive, 0), matches.length - 1), false);
  }

  input.addEventListener('input', () => { highlight(input.value); if (matches.length) goTo(0); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'Enter' && e.shiftKey) { goTo(activeIdx - 1); e.preventDefault(); }
    else if (e.key === 'Enter') { goTo(activeIdx + 1); e.preventDefault(); }
  });
  bar.querySelector('.terminal-search-next').addEventListener('click', () => goTo(activeIdx + 1));
  bar.querySelector('.terminal-search-prev').addEventListener('click', () => goTo(activeIdx - 1));
  bar.querySelector('.terminal-search-close').addEventListener('click', close);

  return { open, close, refresh };
}

// Created once and cached on the viewer element, which outlives every session shown in
// it. Wired on first show rather than at load: `jsonlViewer` is an app.js global, and
// app.js is the last script on the page.
function jsonlFindBar() {
  if (!jsonlViewer._jsonlFindBar) {
    jsonlViewer._jsonlFindBar = createJsonlFindBar();
    // The body is made focusable so a click in the transcript gives it focus and this
    // keydown — which only fires for focus inside the viewer — can reach us.
    jsonlViewerBody.setAttribute('tabindex', '0');
    jsonlViewer.addEventListener('keydown', (e) => {
      const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      if (e.key === 'f' && mod && !e.shiftKey && !e.altKey && jsonlViewer.style.display !== 'none') {
        e.preventDefault();
        openJsonlFind();
      }
    });
  }
  return jsonlViewer._jsonlFindBar;
}

function openJsonlFind(query) {
  jsonlFindBar().open(query);
}

function onTranscriptChanged(sessionId) {
  if (!jsonlTail.session || jsonlTail.session.sessionId !== sessionId) return;
  updateJsonlView();
}

async function updateJsonlView() {
  if (jsonlTailBusy) { jsonlTailPending = true; return; }
  jsonlTailBusy = true;
  try {
    do {
      jsonlTailPending = false;
      await jsonlTailPass();
    } while (jsonlTailPending);
  } finally {
    jsonlTailBusy = false;
  }
}

// One pass of the tail: read what is new, then rebuild the DOM from the unsettled
// boundary down. Every invariant that keeps an append from disturbing the view lives
// here — the generation check, the scroll measurement, and the render boundary.
async function jsonlTailPass() {
  const state = jsonlTail;
  const session = state.session;
  if (!session) return;
  const gen = state.gen;

  const result = await window.api.readSessionTail(session.sessionId, state.cursor);
  // Another session was opened, or the view closed, while we were awaiting.
  if (gen !== state.gen) return;

  if (result.error) {
    // Mid-tail this is transient — the other process may be rewriting the file, and
    // the next change event brings it back. Leave whatever is on screen alone.
    if (!state.raw.length) {
      state.nodes = [];
      jsonlViewerBody.innerHTML = '<div class="plans-empty">No messages to show yet.</div>';
    }
    return;
  }

  // Measured before any DOM change: appending moves scrollHeight, so a reading taken
  // afterwards can no longer tell whether the view was following the bottom.
  const wasAtBottom = jsonlViewerBody.scrollHeight - jsonlViewerBody.scrollTop
    - jsonlViewerBody.clientHeight <= 24;

  state.cursor = result.cursor;
  const entries = result.entries || [];

  if (result.reset) {
    // The file was truncated or rewritten — everything we had may be stale prefix.
    state.raw = entries;
    state.safeFrom = 0;
  } else {
    if (!entries.length) return;
    state.raw = state.raw.concat(entries);
  }

  // Both whole-list passes re-run over the whole entry list every time: a regex walk
  // and a Map build, no DOM. Only the render below is incremental.
  const merged = mergeLocalCommandEntries(state.raw);
  const toolResultMap = new Map();
  for (const el of merged) {
    const blocks = el.entry.message?.content || el.entry.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        toolResultMap.set(block.tool_use_id, block.content || block.output || '');
      }
    }
  }
  // Captured before rendering: renderJsonlEntry claims results out of the map as it
  // goes, and computeSafeFrom needs to know which ones exist at all.
  const resultIds = new Set(toolResultMap.keys());
  const newSafeFrom = computeSafeFrom(merged, resultIds, state.raw.length);

  // Whichever boundary is lower: entries that were unsettled last pass still need
  // replacing, even if they have settled since.
  const renderFrom = Math.min(state.safeFrom, newSafeFrom);
  state.safeFrom = newSafeFrom;

  while (state.nodes.length && state.nodes[state.nodes.length - 1].from >= renderFrom) {
    state.nodes.pop().el.remove();
  }
  // Nothing of ours is left in the body, so whatever else is in it — the empty-state
  // placeholder — has to go before anything is appended below it.
  if (!state.nodes.length) jsonlViewerBody.innerHTML = '';

  for (const el of merged) {
    if (el.from < renderFrom) continue;
    const node = renderJsonlEntry(el.entry, toolResultMap);
    if (!node) continue;
    jsonlViewerBody.appendChild(node);
    state.nodes.push({ from: el.from, el: node });
  }

  if (!state.nodes.length) {
    jsonlViewerBody.innerHTML = '<div class="plans-empty">No messages to show yet.</div>';
  }

  // Click-to-fullscreen for inline images
  jsonlViewerBody.querySelectorAll('.jsonl-clickable-img').forEach(img => {
    img.onclick = () => {
      const overlay = document.createElement('div');
      overlay.className = 'jsonl-screenshot-fullscreen';
      const fullImg = document.createElement('img');
      fullImg.src = img.src;
      overlay.appendChild(fullImg);
      overlay.onclick = () => overlay.remove();
      document.body.appendChild(overlay);
    };
  });

  // Follow the tail only if the view was already at the bottom, so reading back
  // through a session is never yanked forward by the other process writing.
  if (wasAtBottom) jsonlViewerBody.scrollTop = jsonlViewerBody.scrollHeight;

  // The re-render above took every mark below the boundary with it. Rebuild them so the
  // bar's `N` and its active index describe what is now on screen.
  jsonlViewer._jsonlFindBar?.refresh();
}

// Wired once at load. Guarded so this file can also be required in Node for the
// unit tests, where there is no window and no preload bridge.
if (typeof window !== 'undefined' && window.api && window.api.onTranscriptChanged) {
  window.api.onTranscriptChanged(onTranscriptChanged);
}

// Expose the pure list/boundary helpers to Node for unit testing. No-op in the
// browser, where this file is loaded as a plain <script> and `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mergeLocalCommandEntries, computeSafeFrom, getEntryText, conversationText, countOccurrences, UNSETTLED_TOOL_WINDOW };
}
