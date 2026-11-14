/* ramlizer admin interface – plain browser JavaScript, no build step or dependencies. */
(function () {
  "use strict";

  var BASE = (document.querySelector('meta[name="ramlizer-base"]') || {}).content || "/ramlizer";
  var STATE_POLL_MS = 3000;
  var LOG_POLL_MS = 1500;
  var LOG_KEEP = 100;

  var ui = {
    data: null,
    dataSig: "",
    filterText: "",
    filterMethods: new Set(),
    onlyModified: false,
    openDrawers: new Set(),
    tryUrls: new Map(),
    tryResults: new Map(),
    busy: false,
    logSince: 0,
    logEntries: [],
    logClearedAt: 0,
    freshLogIds: new Set()
  };

  var el = {
    stats: document.getElementById("stats"),
    conn: document.getElementById("conn"),
    specs: document.getElementById("spec-list"),
    methods: document.getElementById("method-filters"),
    filterText: document.getElementById("filter-text"),
    filterModified: document.getElementById("filter-modified"),
    content: document.getElementById("content"),
    log: document.getElementById("log"),
    logEmpty: document.getElementById("log-empty"),
    toasts: document.getElementById("toasts"),
    reload: document.getElementById("reload-btn"),
    resetAll: document.getElementById("reset-all-btn"),
    clearLog: document.getElementById("clear-log-btn")
  };

  /* ------------------------------------------------------------ helpers */

  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null || value === false) return;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
        else if (key === "checked" || key === "value" || key === "hidden") node[key] = value;
        else node.setAttribute(key, value === true ? "" : String(value));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }

  function append(node, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) return child.forEach(function (c) { append(node, c); });
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }

  function api(path, body) {
    var opts = body === undefined
      ? { headers: { Accept: "application/json" } }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body)
        };
    return fetch(BASE + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        setOnline(true);
        if (!res.ok) throw new Error(json.error || "Request failed (" + res.status + ")");
        return json;
      });
    }, function (err) {
      setOnline(false);
      throw err;
    });
  }

  function setOnline(online) {
    el.conn.classList.toggle("is-online", online);
    el.conn.classList.toggle("is-offline", !online);
    el.conn.querySelector(".conn-text").textContent = online ? "Live" : "Server unreachable";
  }

  function toast(message, isError) {
    var node = h("div", { class: "toast" + (isError ? " is-error" : ""), text: message });
    el.toasts.appendChild(node);
    setTimeout(function () { node.remove(); }, isError ? 6000 : 2600);
  }

  function statusClass(code) {
    var first = String(code).charAt(0);
    return "status status-" + ("2345".indexOf(first) >= 0 ? first : "2");
  }

  function methodBadge(method) {
    var m = String(method).toLowerCase();
    return h("span", { class: "method method-" + m, text: m });
  }

  function pretty(value) {
    if (value === undefined) return "(no body)";
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }

  function shellQuote(text) {
    return "'" + String(text).replace(/'/g, "'\\''") + "'";
  }

  function timeOf(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function opId(op) {
    return "op-" + op.specId.replace(/[^a-zA-Z0-9_-]/g, "_") + "-" + op.key.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  /** Every selectable (code, example) pair for an operation. */
  function variantsOf(op) {
    var list = [];
    op.responses.forEach(function (r) {
      if (r.examples.length > 0) {
        r.examples.forEach(function (ex) {
          list.push({ code: r.code, example: ex.name, label: ex.name, kind: "example", value: ex.value, response: r });
        });
      } else {
        list.push({
          code: r.code,
          example: "none",
          label: r.hasBody ? "generated" : "no body",
          kind: r.hasBody ? "generated" : "empty",
          value: r.hasBody ? r.generated : undefined,
          response: r
        });
      }
    });
    return list;
  }

  function selectedVariant(op, variants) {
    variants = variants || variantsOf(op);
    for (var i = 0; i < variants.length; i++) {
      if (variants[i].code === op.selectedCode && variants[i].example === op.selectedExample) return variants[i];
    }
    for (var j = 0; j < variants.length; j++) {
      if (variants[j].code === op.selectedCode) return variants[j];
    }
    return null;
  }

  function sampleUrl(route) {
    return route.replace(/\{[^}]+\}/g, "1");
  }

  /* ------------------------------------------------------------ data flow */

  function applyState(state) {
    var sig = JSON.stringify(state);
    if (sig === ui.dataSig) return;
    ui.data = state;
    ui.dataSig = sig;
    render();
  }

  function refreshState() {
    return api("/api/state").then(applyState);
  }

  function mergeOperations(updated) {
    if (!ui.data) return;
    updated.forEach(function (op) {
      ui.data.operations = ui.data.operations.map(function (existing) {
        return existing.key === op.key && existing.specId === op.specId ? op : existing;
      });
    });
    // Selections are shared per method + route, so shadowed copies change too – refetch quietly.
    ui.dataSig = "";
    render();
    refreshState().catch(function () {});
  }

  function select(op, variant) {
    return api("/api/select", { method: op.method, route: op.route, code: variant.code, example: variant.example })
      .then(function (res) {
        mergeOperations(res.operations || []);
        toast(op.method.toUpperCase() + " " + op.route + " → " + variant.code + " · " + variant.label);
      })
      .catch(function (err) {
        toast(err.message, true);
        refreshState().catch(function () {});
      });
  }

  function resetOne(op) {
    return api("/api/reset", { method: op.method, route: op.route }).then(function (res) {
      applyState(res.state);
      toast(op.method.toUpperCase() + " " + op.route + " reset to default");
    }, function (err) { toast(err.message, true); });
  }

  function withBusy(button, work) {
    button.disabled = true;
    return work().then(function () { button.disabled = false; }, function () { button.disabled = false; });
  }

  /* ------------------------------------------------------------ rendering */

  function render() {
    if (!ui.data) return;
    var focusedId = document.activeElement && document.activeElement.id;
    renderStats();
    renderSpecs();
    renderMethodChips();
    renderOperations();
    if (focusedId) {
      var again = document.getElementById(focusedId);
      if (again && again !== document.activeElement) again.focus({ preventScroll: true });
    }
  }

  function renderStats() {
    var specs = ui.data.specs;
    var ops = ui.data.operations;
    var enabled = specs.filter(function (s) { return s.enabled && !s.error; }).length;
    var active = ops.filter(function (o) { return o.active; });
    var changed = active.filter(function (o) { return o.modified; }).length;
    el.stats.replaceChildren(
      h("span", null, h("strong", { text: String(enabled) }), " / " + specs.length + " files on"),
      h("span", null, h("strong", { text: String(active.length) }), " endpoints served"),
      h("span", null, h("strong", { text: String(changed) }), " switched")
    );
  }

  function renderSpecs() {
    var nodes = ui.data.specs.map(function (spec) {
      var id = "spec-toggle-" + spec.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      var meta = [];
      if (spec.ramlVersion) meta.push(h("span", { class: "badge badge-accent", text: "RAML " + spec.ramlVersion }));
      if (spec.version) meta.push(h("span", { class: "badge", text: spec.version }));
      meta.push(h("span", { class: "badge", text: spec.operationCount + " op" + (spec.operationCount === 1 ? "" : "s") }));
      if (spec.warnings && spec.warnings.length) {
        meta.push(h("span", { class: "badge badge-warn", title: spec.warnings.join("\n"), text: spec.warnings.length + " warning" + (spec.warnings.length === 1 ? "" : "s") }));
      }

      return h("li", { class: "spec" + (spec.enabled ? "" : " is-off") },
        h("span", { class: "switch" },
          h("input", {
            type: "checkbox",
            role: "switch",
            id: id,
            checked: spec.enabled,
            "aria-label": (spec.enabled ? "Disable " : "Enable ") + spec.name,
            onchange: function (e) {
              var input = e.target;
              input.disabled = true;
              api("/api/spec", { id: spec.id, enabled: input.checked }).then(function (res) {
                applyState(res.state);
                toast(spec.name + (res.spec.enabled ? " enabled" : " disabled"));
              }, function (err) {
                toast(err.message, true);
                input.checked = !input.checked;
              }).then(function () { input.disabled = false; });
            }
          }),
          h("span", { class: "switch-track", "aria-hidden": "true" })
        ),
        h("div", { class: "spec-body" },
          h("label", { class: "spec-title", for: id, text: spec.title || spec.name }),
          h("div", { class: "spec-file", title: spec.file, text: spec.name }),
          h("div", { class: "spec-meta" }, meta),
          spec.error ? h("div", { class: "spec-error", text: "Failed to load: " + spec.error }) : null,
          spec.enabled && spec.operationCount > 0
            ? h("div", { class: "spec-jump" },
                h("button", {
                  type: "button",
                  class: "link-btn",
                  text: "Jump to endpoints",
                  onclick: function () {
                    var target = document.getElementById("group-" + spec.id.replace(/[^a-zA-Z0-9_-]/g, "_"));
                    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
                  }
                }))
            : null
        )
      );
    });
    if (nodes.length === 0) {
      nodes = [h("li", { class: "group-note", text: "No RAML files found in the configured folder." })];
    }
    el.specs.replaceChildren.apply(el.specs, nodes);
  }

  function renderMethodChips() {
    var methods = Array.from(new Set(ui.data.operations.map(function (o) { return o.method; }))).sort();
    el.methods.replaceChildren.apply(el.methods, methods.map(function (m) {
      return h("button", {
        type: "button",
        class: "chip",
        id: "chip-" + m,
        "aria-pressed": ui.filterMethods.has(m) ? "true" : "false",
        text: m,
        onclick: function () {
          if (ui.filterMethods.has(m)) ui.filterMethods.delete(m); else ui.filterMethods.add(m);
          render();
        }
      });
    }));
  }

  function matchesFilters(op) {
    if (ui.onlyModified && !op.modified) return false;
    if (ui.filterMethods.size && !ui.filterMethods.has(op.method)) return false;
    var q = ui.filterText.trim().toLowerCase();
    if (!q) return true;
    var haystack = [op.method, op.route, op.displayName || "", op.description || "", op.specId]
      .concat(variantsOf(op).map(function (v) { return v.code + " " + v.label; }))
      .join(" ")
      .toLowerCase();
    return haystack.indexOf(q) >= 0;
  }

  function renderOperations() {
    var groups = [];
    var shown = 0;

    ui.data.specs.forEach(function (spec) {
      var groupId = "group-" + spec.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      var ops = ui.data.operations.filter(function (o) { return o.specId === spec.id; });
      var visible = ops.filter(matchesFilters);
      var body;

      if (spec.error && ops.length === 0) {
        body = h("div", { class: "group-note", text: "This file could not be parsed: " + spec.error });
      } else if (!spec.enabled) {
        body = h("div", { class: "group-note", text: "Disabled – its " + ops.length + " endpoint" + (ops.length === 1 ? " is" : "s are") + " not being served. Switch it on in the RAML files panel." });
      } else if (visible.length === 0) {
        if (ops.length > 0) return; // filtered out entirely
        body = h("div", { class: "group-note", text: "No endpoints with methods are declared in this file." });
      } else {
        shown += visible.length;
        body = h("div", { class: "group-body" }, visible.map(renderOperation));
      }

      groups.push(h("section", { class: "group", id: groupId, "aria-labelledby": groupId + "-title" },
        h("div", { class: "group-head" },
          h("h2", { id: groupId + "-title", text: spec.title || spec.name }),
          h("span", { class: "group-file", text: spec.name })
        ),
        body
      ));
    });

    if (groups.length === 0 || (shown === 0 && (ui.filterText || ui.filterMethods.size || ui.onlyModified))) {
      groups.unshift(h("div", { class: "empty", text: ui.data.specs.length ? "No endpoints match the current filter." : "No RAML files loaded." }));
    }
    el.content.replaceChildren.apply(el.content, groups);
  }

  function renderOperation(op) {
    var id = opId(op);
    var variants = variantsOf(op);
    var current = selectedVariant(op, variants);
    var drawerOpen = ui.openDrawers.has(id);

    var tags = [];
    if (op.modified) tags.push(h("span", { class: "badge badge-accent", text: "switched" }));
    if (op.shadowedBy) tags.push(h("span", { class: "badge badge-warn", title: "Another enabled RAML file already serves this method and route", text: "shadowed by " + op.shadowedBy }));

    var variantGroup = variants.length
      ? h("fieldset", { class: "variants" },
          h("legend", { text: "Response" }),
          variants.map(function (v, i) {
            var inputId = id + "-v" + i;
            var isDefault = v.code === op.defaultCode && v.example === op.defaultExample;
            return h("label", { class: "variant", for: inputId, title: v.response.description || "" },
              h("input", {
                type: "radio",
                id: inputId,
                name: id + "-variant",
                checked: current === v,
                onchange: function () { select(op, v); }
              }),
              h("span", { class: statusClass(v.code), text: v.code }),
              h("span", { class: "variant-name", text: v.label }),
              isDefault ? h("span", { class: "variant-default", text: "default" }) : null
            );
          })
        )
      : h("p", { class: "op-desc", text: "This operation declares no responses; ramlizer will answer 200 with an empty object." });

    var curl = "curl -s -X POST " + shellQuote(location.origin + BASE) +
      " -H 'Content-Type: application/json' -d " +
      shellQuote(JSON.stringify({ route: op.route, method: op.method, nextResponseCode: current ? current.code : op.selectedCode, nextExampleName: current ? current.example : op.selectedExample }));

    var tryUrl = ui.tryUrls.has(id) ? ui.tryUrls.get(id) : sampleUrl(op.route);
    var tryResult = ui.tryResults.get(id);

    var drawer = h("div", { class: "drawer", id: id + "-drawer", hidden: !drawerOpen },
      h("div", null,
        h("div", { class: "drawer-label" }, "Will respond with",
          current ? h("span", { class: statusClass(current.code), text: current.code }) : null,
          current && current.response.contentTypes.length ? h("span", { class: "badge", text: current.response.contentTypes[0] }) : null,
          current && current.kind === "generated" ? h("span", { class: "badge", title: "No example in the RAML – synthesised from the declared type", text: "synthesised" }) : null
        ),
        h("pre", { class: "code", text: current ? pretty(current.value) : "(no matching response)" })
      ),
      h("div", null,
        h("div", { class: "drawer-label", text: "Try it against the mock" }),
        h("form", {
          class: "try-row",
          onsubmit: function (e) {
            e.preventDefault();
            sendTry(op, id);
          }
        },
          h("label", { class: "sr-only", for: id + "-url", text: "Request path" }),
          h("input", {
            id: id + "-url",
            value: tryUrl,
            spellcheck: "false",
            oninput: function (e) { ui.tryUrls.set(id, e.target.value); }
          }),
          h("button", { type: "submit", class: "btn btn-small", text: "Send " + op.method.toUpperCase() })
        ),
        tryResult ? h("div", { class: "try-result" },
          h("div", { class: "try-meta" },
            tryResult.error ? h("span", { class: "status status-5", text: "Network error" }) : h("span", { class: statusClass(tryResult.status), text: String(tryResult.status) }),
            h("span", { text: tryResult.ms + " ms" }),
            tryResult.type ? h("span", { text: tryResult.type }) : null
          ),
          h("pre", { class: "code", text: tryResult.error || tryResult.body || "(empty body)" })
        ) : null
      )
    );

    return h("article", {
      class: "op" + (op.modified ? " is-modified" : "") + (op.active ? "" : " is-inactive"),
      id: id,
      "aria-label": op.method.toUpperCase() + " " + op.route
    },
      h("div", { class: "op-head" },
        methodBadge(op.method),
        h("span", { class: "op-route", text: op.route }),
        h("div", { class: "op-tags" }, tags)
      ),
      op.description || op.displayName ? h("p", { class: "op-desc", text: op.description || op.displayName }) : null,
      variantGroup,
      h("div", { class: "op-foot" },
        h("span", { class: "serving" }, "Serving ",
          h("strong", { text: current ? current.code + " · " + current.label : op.selectedCode })),
        h("span", { class: "spacer" }),
        h("button", {
          type: "button",
          class: "btn btn-small btn-ghost",
          id: id + "-toggle",
          "aria-expanded": drawerOpen ? "true" : "false",
          "aria-controls": id + "-drawer",
          text: drawerOpen ? "Hide preview" : "Preview & try",
          onclick: function () {
            if (ui.openDrawers.has(id)) ui.openDrawers.delete(id); else ui.openDrawers.add(id);
            render();
          }
        }),
        h("button", {
          type: "button",
          class: "btn btn-small btn-ghost",
          id: id + "-curl",
          title: "Copy a curl command that switches to this response – handy in test scripts",
          text: "Copy curl",
          onclick: function () { copyText(curl, "curl command copied"); }
        }),
        op.modified ? h("button", {
          type: "button",
          class: "btn btn-small btn-ghost",
          id: id + "-reset",
          text: "Reset",
          onclick: function () { resetOne(op); }
        }) : null
      ),
      drawer
    );
  }

  function sendTry(op, id) {
    var path = (ui.tryUrls.get(id) || sampleUrl(op.route)).trim();
    if (path.charAt(0) !== "/") path = "/" + path;
    var started = performance.now();
    var init = { method: op.method.toUpperCase(), headers: { Accept: "application/json" } };
    if (["post", "put", "patch"].indexOf(op.method) >= 0) {
      init.headers["Content-Type"] = "application/json";
      init.body = "{}";
    }
    fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var body = text;
        try { body = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* not JSON */ }
        ui.tryResults.set(id, { status: res.status, body: body, type: res.headers.get("Content-Type"), ms: Math.round(performance.now() - started) });
      });
    }).catch(function (err) {
      ui.tryResults.set(id, { error: err.message, ms: Math.round(performance.now() - started) });
    }).then(function () {
      render();
      pollLog();
    });
  }

  function copyText(text, message) {
    var done = function () { toast(message); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var area = h("textarea", { class: "sr-only", readonly: true });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed – select the text manually", true); }
    area.remove();
  }

  /* ------------------------------------------------------------ request log */

  function renderLog() {
    var entries = ui.logEntries.slice().reverse();
    el.logEmpty.hidden = entries.length > 0;
    el.log.replaceChildren.apply(el.log, entries.map(function (entry) {
      return h("li", { class: ui.freshLogIds.has(entry.id) ? "is-new" : "" },
        methodBadge(entry.method),
        h("span", { class: statusClass(entry.status), text: String(entry.status) }),
        h("span", { class: "log-path", text: entry.path }),
        h("span", { class: "log-meta" },
          h("span", { text: timeOf(entry.time) }),
          h("span", { text: entry.example === "none" ? "no body" : entry.example }),
          entry.specId ? h("span", { text: entry.specId }) : null
        )
      );
    }));
    ui.freshLogIds.clear();
  }

  function pollLog() {
    return api("/api/log?since=" + ui.logSince).then(function (res) {
      var entries = res.entries || [];
      if (!entries.length) return;
      entries.forEach(function (e) {
        ui.logSince = Math.max(ui.logSince, e.id);
        if (e.id > ui.logClearedAt) {
          ui.logEntries.push(e);
          ui.freshLogIds.add(e.id);
        }
      });
      if (ui.logEntries.length > LOG_KEEP) ui.logEntries.splice(0, ui.logEntries.length - LOG_KEEP);
      renderLog();
    });
  }

  /* ------------------------------------------------------------ wiring */

  el.filterText.addEventListener("input", function (e) {
    ui.filterText = e.target.value;
    renderOperations();
  });

  el.filterModified.addEventListener("change", function (e) {
    ui.onlyModified = e.target.checked;
    renderOperations();
  });

  el.reload.addEventListener("click", function () {
    withBusy(el.reload, function () {
      return api("/api/reload", {}).then(function (state) {
        applyState(state);
        var failed = state.specs.filter(function (s) { return s.error; });
        if (failed.length) toast(failed.length + " file(s) failed to load – see the RAML files panel", true);
        else toast("Reloaded " + state.specs.length + " RAML file(s) from disk");
      }, function (err) { toast(err.message, true); });
    });
  });

  el.resetAll.addEventListener("click", function () {
    withBusy(el.resetAll, function () {
      return api("/api/reset", {}).then(function (res) {
        applyState(res.state);
        toast("Reset " + res.reset + " endpoint(s) to their defaults");
      }, function (err) { toast(err.message, true); });
    });
  });

  el.clearLog.addEventListener("click", function () {
    ui.logClearedAt = ui.logSince;
    ui.logEntries = [];
    renderLog();
  });

  // Prime the log cursor so the panel starts with recent history rather than nothing.
  refreshState()
    .catch(function (err) {
      el.content.replaceChildren(h("div", { class: "empty", text: "Could not reach ramlizer: " + err.message }));
    })
    .then(pollLog)
    .catch(function () {});

  setInterval(function () {
    if (document.hidden) return;
    refreshState().catch(function () {});
  }, STATE_POLL_MS);

  setInterval(function () {
    if (document.hidden) return;
    pollLog().catch(function () {});
  }, LOG_POLL_MS);

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refreshState().catch(function () {});
  });
})();
