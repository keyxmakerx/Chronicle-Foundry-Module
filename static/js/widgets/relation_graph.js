/**
 * relation_graph.js -- D3.js Force-Directed Relations Graph Widget
 *
 * Renders an interactive SVG graph of entity relations within a campaign.
 * Entities are nodes colored by their entity type; relations are edges
 * with labels. Supports zoom/pan, click-to-navigate, and hover tooltips.
 *
 * Mount: <div data-widget="relation-graph"
 *             data-campaign-id="..."
 *             data-api-url="/campaigns/:id/relations/graph"
 *             data-mode="full|compact">
 *
 * Requires D3.js v7. Loaded dynamically from CDN if not already present.
 *
 * Load-order safe: if boot.js hasn't executed yet (Chronicle undefined),
 * registration is deferred until DOMContentLoaded.
 */
(function() {
var _impl = {
  /** CDN URL used to dynamically load D3 when it's not already available. */
  _d3Src: 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js',

  /**
   * Initialize the relation graph widget.
   * @param {HTMLElement} el - Mount point element.
   * @param {Object} config - Parsed data-* attributes.
   */
  init: function(el, config) {
    this.el = el;
    this.config = config;
    this.apiUrl = config.apiUrl || '/campaigns/' + config.campaignId + '/relations/graph';
    this.mode = config.mode || 'full';
    this.simulation = null;
    this.svg = null;
    this._resizeHandler = null;

    this._ensureD3(function() {
      this._loadData();
    }.bind(this));
  },

  /**
   * Dynamically load D3.js from the CDN if it hasn't been loaded yet.
   * @param {Function} cb - Callback invoked once D3 is available.
   */
  _ensureD3: function(cb) {
    var self = this;

    // Show loading state.
    this.el.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;min-height:' +
      (this.mode === 'compact' ? '300px' : '600px') + '">' +
        '<div style="text-align:center">' +
          '<i class="fa-solid fa-spinner fa-spin text-2xl mb-3" style="color:var(--color-fg-muted)"></i>' +
          '<p class="text-sm" style="color:var(--color-fg-muted)">Loading graph...</p>' +
        '</div>' +
      '</div>';

    // Already loaded.
    if (typeof d3 !== 'undefined') { cb(); return; }

    // Check if another script element is already loading D3.
    var existing = document.querySelector('script[src="' + this._d3Src + '"]');
    if (existing) {
      var attempts = 0;
      var poll = setInterval(function() {
        if (typeof d3 !== 'undefined') { clearInterval(poll); cb(); return; }
        if (++attempts > 100) {
          clearInterval(poll);
          self._showError('Failed to load D3.js');
        }
      }, 100);
      return;
    }

    // Load D3 from CDN.
    var script = document.createElement('script');
    script.src = this._d3Src;
    script.onload = function() { cb(); };
    script.onerror = function() { self._showError('Failed to load D3.js'); };
    document.head.appendChild(script);
  },

  /** Fetch graph data from the API and render. */
  _loadData: function() {
    var self = this;
    var fetchFn = (typeof Chronicle !== 'undefined' && Chronicle.apiFetch)
      ? Chronicle.apiFetch
      : fetch;

    fetchFn(this.apiUrl)
      .then(function(r) { return r.json(); })
      .then(function(data) { self._render(data); })
      .catch(function(err) { self._showError('Failed to load graph data'); });
  },

  /** Show an error message in the container. */
  _showError: function(msg) {
    this.el.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;min-height:200px">' +
        '<div style="text-align:center">' +
          '<i class="fa-solid fa-triangle-exclamation text-2xl mb-3" style="color:var(--color-fg-muted)"></i>' +
          '<p class="text-sm" style="color:var(--color-fg-muted)">' + msg + '</p>' +
        '</div>' +
      '</div>';
  },

  /**
   * Render the force-directed graph using D3.
   * @param {Object} data - { nodes: GraphNode[], edges: GraphEdge[] }
   */
  _render: function(data) {
    var self = this;
    var nodes = data.nodes || [];
    var edges = data.edges || [];

    if (nodes.length === 0) {
      this.el.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;min-height:' +
        (this.mode === 'compact' ? '200px' : '400px') + '">' +
          '<div style="text-align:center">' +
            '<i class="fa-solid fa-diagram-project text-3xl mb-3" style="color:var(--color-fg-muted)"></i>' +
            '<p class="text-sm" style="color:var(--color-fg-muted)">No relations yet</p>' +
            '<p class="text-xs mt-1" style="color:var(--color-fg-muted)">Create relations between entities to see them here</p>' +
          '</div>' +
        '</div>';
      return;
    }

    // Clear container and set up SVG.
    this.el.innerHTML = '';
    var rect = this.el.getBoundingClientRect();
    var width = rect.width || 800;
    var height = this.mode === 'compact' ? 300 : Math.max(600, rect.height);

    var svg = d3.select(this.el)
      .append('svg')
      .attr('width', '100%')
      .attr('height', height)
      .attr('viewBox', [0, 0, width, height])
      .attr('style', 'max-width:100%;height:auto;cursor:grab');

    this.svg = svg;

    // Arrow marker for directed edges.
    svg.append('defs').append('marker')
      .attr('id', 'rg-arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 25)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', 'var(--color-fg-muted, #9ca3af)');

    // Main group for zoom/pan transforms.
    var g = svg.append('g');

    // Zoom behavior.
    var zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', function(event) {
        g.attr('transform', event.transform);
      });
    svg.call(zoom);

    // Build link index for D3 (convert IDs to node references).
    var links = edges.map(function(e) {
      return { source: e.source, target: e.target, label: e.label };
    });

    // Force simulation.
    var simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(function(d) { return d.id; }).distance(120))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide(35));

    this.simulation = simulation;

    // Draw edges.
    var link = g.append('g')
      .attr('class', 'rg-links')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', 'var(--color-edge, #d1d5db)')
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', 1.5)
      .attr('marker-end', 'url(#rg-arrow)');

    // Edge labels (shown on hover via CSS).
    var linkLabel = g.append('g')
      .attr('class', 'rg-link-labels')
      .selectAll('text')
      .data(links)
      .join('text')
      .text(function(d) { return d.label; })
      .attr('font-size', '10px')
      .attr('fill', 'var(--color-fg-secondary, #6b7280)')
      .attr('text-anchor', 'middle')
      .attr('dy', -4)
      .attr('opacity', 0)
      .attr('pointer-events', 'none');

    // Draw nodes.
    var node = g.append('g')
      .attr('class', 'rg-nodes')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(d3.drag()
        .on('start', function(event, d) {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
          svg.attr('style', 'max-width:100%;height:auto;cursor:grabbing');
        })
        .on('drag', function(event, d) {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', function(event, d) {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
          svg.attr('style', 'max-width:100%;height:auto;cursor:grab');
        })
      );

    // Node circle.
    node.append('circle')
      .attr('r', 18)
      .attr('fill', function(d) { return d.color || '#6b7280'; })
      .attr('stroke', 'var(--color-bg, #fff)')
      .attr('stroke-width', 2)
      .attr('opacity', 0.9);

    // Node icon (FontAwesome Unicode via text).
    node.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('font-family', '"Font Awesome 6 Free"')
      .attr('font-weight', 900)
      .attr('font-size', '11px')
      .attr('fill', '#fff')
      .attr('pointer-events', 'none')
      .text(function(d) {
        // Map common FA class names to Unicode chars.
        return self._faIconChar(d.icon);
      });

    // Node label (name).
    node.append('text')
      .attr('dy', 32)
      .attr('text-anchor', 'middle')
      .attr('font-size', '11px')
      .attr('fill', 'var(--color-fg, #111)')
      .attr('pointer-events', 'none')
      .text(function(d) {
        return d.name.length > 16 ? d.name.substring(0, 14) + '...' : d.name;
      });

    // Tooltip on hover.
    var tooltip = d3.select(this.el)
      .append('div')
      .attr('class', 'rg-tooltip')
      .style('position', 'absolute')
      .style('pointer-events', 'none')
      .style('background', 'var(--color-bg-raised, #fff)')
      .style('border', '1px solid var(--color-edge, #e5e7eb)')
      .style('border-radius', '6px')
      .style('padding', '6px 10px')
      .style('font-size', '12px')
      .style('color', 'var(--color-fg, #111)')
      .style('box-shadow', '0 2px 8px rgba(0,0,0,0.12)')
      .style('opacity', 0)
      .style('z-index', 50)
      .style('white-space', 'nowrap');

    // Node hover: show tooltip + highlight edges.
    node.on('mouseover', function(event, d) {
      tooltip
        .html('<strong>' + d.name + '</strong>' + (d.type ? '<br><span style="color:var(--color-fg-secondary)">' + d.type + '</span>' : ''))
        .style('opacity', 1);

      // Highlight connected edges.
      link.attr('stroke-opacity', function(l) {
        return (l.source.id === d.id || l.target.id === d.id) ? 1 : 0.15;
      }).attr('stroke-width', function(l) {
        return (l.source.id === d.id || l.target.id === d.id) ? 2.5 : 1;
      });

      // Show labels for connected edges.
      linkLabel.attr('opacity', function(l) {
        return (l.source.id === d.id || l.target.id === d.id) ? 1 : 0;
      });

      // Dim other nodes.
      var connectedIds = {};
      connectedIds[d.id] = true;
      links.forEach(function(l) {
        if (l.source.id === d.id) connectedIds[l.target.id] = true;
        if (l.target.id === d.id) connectedIds[l.source.id] = true;
      });
      node.select('circle').attr('opacity', function(n) {
        return connectedIds[n.id] ? 0.9 : 0.25;
      });
    })
    .on('mousemove', function(event) {
      var bounds = self.el.getBoundingClientRect();
      tooltip
        .style('left', (event.clientX - bounds.left + 12) + 'px')
        .style('top', (event.clientY - bounds.top - 10) + 'px');
    })
    .on('mouseout', function() {
      tooltip.style('opacity', 0);
      link.attr('stroke-opacity', 0.6).attr('stroke-width', 1.5);
      linkLabel.attr('opacity', 0);
      node.select('circle').attr('opacity', 0.9);
    });

    // Click to navigate.
    node.on('click', function(event, d) {
      if (d.url) window.location.href = d.url;
    });

    // Simulation tick: update positions.
    simulation.on('tick', function() {
      link
        .attr('x1', function(d) { return d.source.x; })
        .attr('y1', function(d) { return d.source.y; })
        .attr('x2', function(d) { return d.target.x; })
        .attr('y2', function(d) { return d.target.y; });

      linkLabel
        .attr('x', function(d) { return (d.source.x + d.target.x) / 2; })
        .attr('y', function(d) { return (d.source.y + d.target.y) / 2; });

      node.attr('transform', function(d) {
        return 'translate(' + d.x + ',' + d.y + ')';
      });
    });

    // Zoom to fit after simulation settles.
    simulation.on('end', function() {
      self._zoomToFit(svg, g, zoom, width, height, nodes);
    });

    // Handle resize.
    this._resizeHandler = function() {
      var newRect = self.el.getBoundingClientRect();
      var newWidth = newRect.width || 800;
      var newHeight = self.mode === 'compact' ? 300 : Math.max(600, newRect.height);
      svg.attr('viewBox', [0, 0, newWidth, newHeight]);
    };
    window.addEventListener('resize', this._resizeHandler);

    // Build legend.
    this._buildLegend(nodes);
  },

  /** Zoom to fit all nodes within the viewport with padding. */
  _zoomToFit: function(svg, g, zoom, width, height, nodes) {
    if (nodes.length === 0) return;

    var xMin = d3.min(nodes, function(d) { return d.x; }) - 40;
    var xMax = d3.max(nodes, function(d) { return d.x; }) + 40;
    var yMin = d3.min(nodes, function(d) { return d.y; }) - 40;
    var yMax = d3.max(nodes, function(d) { return d.y; }) + 40;

    var graphWidth = xMax - xMin;
    var graphHeight = yMax - yMin;

    var scale = Math.min(width / graphWidth, height / graphHeight, 2) * 0.9;
    var tx = (width - graphWidth * scale) / 2 - xMin * scale;
    var ty = (height - graphHeight * scale) / 2 - yMin * scale;

    svg.transition().duration(750).call(
      zoom.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
  },

  /** Build a legend showing entity type colors. */
  _buildLegend: function(nodes) {
    // Collect unique types with their colors.
    var types = {};
    nodes.forEach(function(n) {
      if (n.type && !types[n.type]) {
        types[n.type] = n.color || '#6b7280';
      }
    });

    var entries = Object.keys(types);
    if (entries.length === 0) return;

    var legend = document.createElement('div');
    legend.className = 'rg-legend';
    legend.style.cssText = 'position:absolute;top:8px;right:8px;background:var(--color-bg-raised,#fff);' +
      'border:1px solid var(--color-edge,#e5e7eb);border-radius:6px;padding:8px 12px;font-size:11px;' +
      'color:var(--color-fg-secondary,#6b7280);z-index:10;max-width:200px';

    var html = '<div style="font-weight:600;margin-bottom:4px;font-size:10px;text-transform:uppercase;letter-spacing:0.05em">Entity Types</div>';
    entries.forEach(function(type) {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-top:3px">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + types[type] + ';display:inline-block;flex-shrink:0"></span>' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + type + '</span>' +
        '</div>';
    });
    legend.innerHTML = html;

    // Make container relative for absolute positioning.
    this.el.style.position = 'relative';
    this.el.appendChild(legend);
  },

  /**
   * Map a FontAwesome class name to its Unicode character.
   * Falls back to a generic dot for unknown icons.
   */
  _faIconChar: function(iconClass) {
    if (!iconClass) return '\u25CF'; // bullet
    // Common FA icons used in Chronicle entity types.
    var map = {
      'fa-user': '\uf007',
      'fa-users': '\uf0c0',
      'fa-map-marker-alt': '\uf3c5',
      'fa-map-pin': '\uf276',
      'fa-location-dot': '\uf3c5',
      'fa-building': '\uf1ad',
      'fa-landmark': '\uf66f',
      'fa-crown': '\uf521',
      'fa-shield': '\uf132',
      'fa-shield-halved': '\uf3ed',
      'fa-sword': '\uf71c',
      'fa-scroll': '\uf70e',
      'fa-book': '\uf02a',
      'fa-book-open': '\uf518',
      'fa-skull': '\uf54c',
      'fa-dragon': '\uf6d5',
      'fa-paw': '\uf1b0',
      'fa-horse': '\uf6f0',
      'fa-tree': '\uf1bb',
      'fa-mountain': '\uf6fc',
      'fa-globe': '\uf0ac',
      'fa-gem': '\uf3a5',
      'fa-ring': '\uf70b',
      'fa-hat-wizard': '\uf6e8',
      'fa-dungeon': '\uf6d9',
      'fa-store': '\uf54e',
      'fa-church': '\uf51d',
      'fa-flag': '\uf024',
      'fa-file': '\uf15b',
      'fa-star': '\uf005',
      'fa-heart': '\uf004',
      'fa-bolt': '\uf0e7',
      'fa-fire': '\uf06d',
      'fa-water': '\uf773',
      'fa-wind': '\uf72e',
      'fa-moon': '\uf186',
      'fa-sun': '\uf185',
      'fa-eye': '\uf06e',
      'fa-key': '\uf084',
      'fa-hammer': '\uf6e3',
      'fa-flask': '\uf0c3',
      'fa-compass': '\uf14e',
      'fa-ship': '\uf21a',
      'fa-castle': '\ue0de',
      'fa-fort': '\ue486',
      'fa-house': '\uf015',
      'fa-tent': '\ue57d',
      'fa-city': '\uf64f',
      'fa-swords': '\uf71d',
      'fa-people-group': '\ue533',
      'fa-handshake': '\uf2b5',
      'fa-scale-balanced': '\uf24e',
      'fa-dice-d20': '\uf6cf',
    };
    // Strip 'fa-solid ' prefix if present.
    var name = iconClass.replace('fa-solid ', '').trim();
    return map[name] || '\u25CF';
  },

  /** Clean up: stop simulation, remove resize handler, clear DOM. */
  destroy: function(el) {
    if (this.simulation) {
      this.simulation.stop();
      this.simulation = null;
    }
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (el) el.innerHTML = '';
    this.svg = null;
  }
};

// Register with Chronicle's widget system.
function _register() { Chronicle.register('relation-graph', _impl); }
if (typeof Chronicle !== 'undefined') {
  _register();
} else {
  document.addEventListener('DOMContentLoaded', _register);
}
})();
