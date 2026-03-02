/**
 * timeline_viz.js -- D3.js Interactive Timeline Visualization Widget
 *
 * Renders an interactive SVG timeline with:
 *   - Horizontal time axis (year-level default zoom)
 *   - Event markers positioned by date (year, month, day)
 *   - Pan/drag via d3.zoom
 *   - Zoom in/out with mouse wheel and toolbar buttons
 *   - Tooltips on hover (event name, date, entity, category)
 *   - Color-coded events (per-link override or timeline default color)
 *   - Entity group swim-lanes (when groups exist)
 *   - Skip-to-date input
 *
 * Mount: <div data-widget="timeline-viz"
 *             data-campaign-id="..."
 *             data-timeline-id="..."
 *             data-timeline-color="..."
 *             data-api-url="...">
 *
 * Requires D3.js v7 to be loaded on the page before this widget initializes.
 */
Chronicle.register('timeline-viz', {
  /**
   * Initialize the timeline visualization.
   * @param {HTMLElement} el - Mount point element.
   * @param {Object} config - Parsed data-* attributes.
   */
  init: function(el, config) {
    var self = this;
    this.el = el;
    this.config = config;
    this.apiUrl = config.apiUrl;
    this.timelineColor = config.timelineColor || '#6366f1';
    this.events = [];
    this.groups = [];
    this.timeline = null;
    this.tooltip = null;
    this.svg = null;
    this.zoom = null;
    this.currentTransform = d3.zoomIdentity;

    // Layout constants.
    this.margin = { top: 60, right: 40, bottom: 40, left: 40 };
    this.rowHeight = 36;
    this.eventRadius = 6;
    this.laneHeight = 50;

    this._buildDOM();
    this._loadData();
  },

  /**
   * Build the widget DOM structure (toolbar + SVG container).
   */
  _buildDOM: function() {
    this.el.innerHTML = '';
    this.el.classList.add('timeline-viz-container');

    // Toolbar.
    var toolbar = document.createElement('div');
    toolbar.className = 'timeline-viz-toolbar';
    toolbar.innerHTML =
      '<div class="timeline-viz-toolbar-left">' +
        '<button class="timeline-viz-btn" data-action="zoom-in" title="Zoom in">' +
          '<i class="fa-solid fa-plus"></i>' +
        '</button>' +
        '<button class="timeline-viz-btn" data-action="zoom-out" title="Zoom out">' +
          '<i class="fa-solid fa-minus"></i>' +
        '</button>' +
        '<button class="timeline-viz-btn" data-action="zoom-fit" title="Fit all events">' +
          '<i class="fa-solid fa-expand"></i>' +
        '</button>' +
        '<span class="timeline-viz-zoom-label">Year</span>' +
      '</div>' +
      '<div class="timeline-viz-toolbar-right">' +
        '<label class="timeline-viz-skip-label">Go to year:</label>' +
        '<input type="number" class="timeline-viz-skip-input" placeholder="Year"/>' +
        '<button class="timeline-viz-btn" data-action="skip-to">' +
          '<i class="fa-solid fa-arrow-right"></i>' +
        '</button>' +
      '</div>';
    this.el.appendChild(toolbar);

    // SVG container.
    var svgContainer = document.createElement('div');
    svgContainer.className = 'timeline-viz-svg-wrap';
    this.el.appendChild(svgContainer);
    this.svgContainer = svgContainer;

    // Tooltip.
    var tip = document.createElement('div');
    tip.className = 'timeline-viz-tooltip';
    tip.style.display = 'none';
    document.body.appendChild(tip);
    this.tooltip = tip;

    // Wire toolbar buttons.
    var self = this;
    toolbar.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      if (action === 'zoom-in') self._zoomBy(1.5);
      else if (action === 'zoom-out') self._zoomBy(1 / 1.5);
      else if (action === 'zoom-fit') self._zoomFit();
      else if (action === 'skip-to') self._skipToYear();
    });

    // Enter key on skip input.
    var skipInput = toolbar.querySelector('.timeline-viz-skip-input');
    skipInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') self._skipToYear();
    });
  },

  /**
   * Fetch timeline data from the API and render.
   */
  _loadData: function() {
    var self = this;
    fetch(this.apiUrl)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        self.timeline = data.timeline;
        self.events = (data.events || []).slice();
        self.groups = data.groups || [];

        // Sort events by date.
        self.events.sort(function(a, b) {
          var ya = a.event_year, yb = b.event_year;
          if (ya !== yb) return ya - yb;
          var ma = a.event_month, mb = b.event_month;
          if (ma !== mb) return ma - mb;
          return a.event_day - b.event_day;
        });

        self._render();
      })
      .catch(function(err) {
        console.warn('[timeline-viz] Failed to load data:', err);
        self.svgContainer.innerHTML =
          '<div class="timeline-viz-empty">Failed to load timeline data.</div>';
      });
  },

  /**
   * Main render: build scales, axes, and event markers.
   */
  _render: function() {
    if (this.events.length === 0) {
      this.svgContainer.innerHTML =
        '<div class="timeline-viz-empty">' +
          '<i class="fa-solid fa-calendar-plus text-3xl text-fg-muted mb-3"></i>' +
          '<p>No events to display.</p>' +
          '<p class="text-xs text-fg-muted mt-1">Link calendar events to see them on the timeline.</p>' +
        '</div>';
      return;
    }

    var self = this;
    var container = this.svgContainer;
    var width = container.clientWidth || 800;
    var m = this.margin;

    // Compute year range.
    var minYear = d3.min(this.events, function(d) { return d.event_year; });
    var maxYear = d3.max(this.events, function(d) { return d.event_year; });
    // Add padding of 1 year on each side.
    minYear = minYear - 1;
    maxYear = maxYear + 1;

    // Build swim-lanes: one lane per entity group, plus "Ungrouped" lane.
    var lanes = this._buildLanes();
    var laneCount = Math.max(lanes.length, 1);
    var contentHeight = laneCount * this.laneHeight;
    var height = m.top + contentHeight + m.bottom;

    // Create SVG.
    container.innerHTML = '';
    var svg = d3.select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height)
      .attr('class', 'timeline-viz-svg');
    this.svg = svg;
    this.width = width;
    this.height = height;

    // Clip path for the main content area.
    svg.append('defs')
      .append('clipPath')
      .attr('id', 'timeline-clip')
      .append('rect')
      .attr('x', m.left)
      .attr('y', m.top)
      .attr('width', width - m.left - m.right)
      .attr('height', contentHeight);

    // X scale: maps year values to pixel positions.
    var xScale = d3.scaleLinear()
      .domain([minYear, maxYear])
      .range([m.left, width - m.right]);
    this.xScale = xScale;
    this.xScaleOrig = xScale.copy();

    // Y scale: maps lane index to vertical position.
    var yScale = d3.scaleBand()
      .domain(d3.range(laneCount))
      .range([m.top, m.top + contentHeight])
      .padding(0.1);
    this.yScale = yScale;

    // Background.
    svg.append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'var(--color-surface, #1a1b26)')
      .attr('rx', 8);

    // Grid lines group (behind everything).
    this.gridGroup = svg.append('g').attr('class', 'timeline-grid');

    // Swim-lane backgrounds.
    this.laneGroup = svg.append('g').attr('class', 'timeline-lanes');
    var laneData = lanes.length > 0 ? lanes : [{ name: 'Events', color: null, entityIDs: null }];
    this.laneGroup.selectAll('rect')
      .data(laneData)
      .enter()
      .append('rect')
      .attr('x', m.left)
      .attr('y', function(d, i) { return yScale(i); })
      .attr('width', width - m.left - m.right)
      .attr('height', yScale.bandwidth())
      .attr('fill', function(d, i) {
        return i % 2 === 0
          ? 'var(--color-surface-alt, #24253a)'
          : 'transparent';
      })
      .attr('rx', 4);

    // Lane labels.
    if (lanes.length > 1) {
      this.laneGroup.selectAll('text')
        .data(laneData)
        .enter()
        .append('text')
        .attr('x', m.left + 6)
        .attr('y', function(d, i) { return yScale(i) + 14; })
        .attr('class', 'timeline-lane-label')
        .text(function(d) { return d.name; });
    }

    // Axis group.
    this.axisGroup = svg.append('g')
      .attr('class', 'timeline-axis')
      .attr('transform', 'translate(0,' + m.top + ')');

    // Main content group (clipped).
    this.contentGroup = svg.append('g')
      .attr('clip-path', 'url(#timeline-clip)');

    // Assign lane index to each event.
    this._assignLanes(lanes);

    // Draw events.
    this._drawEvents();
    this._drawAxis();
    this._drawGrid();

    // Setup zoom behavior.
    this.zoom = d3.zoom()
      .scaleExtent([0.1, 50])
      .translateExtent([[-Infinity, 0], [Infinity, height]])
      .on('zoom', function(event) {
        self.currentTransform = event.transform;
        self._onZoom();
      });

    svg.call(this.zoom);

    // Update zoom label.
    this._updateZoomLabel();
  },

  /**
   * Build swim-lane definitions from entity groups.
   */
  _buildLanes: function() {
    if (!this.groups || this.groups.length === 0) {
      return [];
    }
    var lanes = [];
    for (var i = 0; i < this.groups.length; i++) {
      var g = this.groups[i];
      var entityIDs = {};
      if (g.members) {
        for (var j = 0; j < g.members.length; j++) {
          entityIDs[g.members[j].entity_id] = true;
        }
      }
      lanes.push({ name: g.name, color: g.color, entityIDs: entityIDs });
    }
    // Add "Other" lane for events without a matching group.
    lanes.push({ name: 'Other', color: null, entityIDs: null });
    return lanes;
  },

  /**
   * Assign a lane index to each event based on its entity_id.
   */
  _assignLanes: function(lanes) {
    for (var i = 0; i < this.events.length; i++) {
      var evt = this.events[i];
      evt._lane = 0; // default
      if (lanes.length > 0 && evt.event_entity_id) {
        for (var j = 0; j < lanes.length; j++) {
          if (lanes[j].entityIDs && lanes[j].entityIDs[evt.event_entity_id]) {
            evt._lane = j;
            break;
          }
          // Last lane is "Other" - catches everything unmatched.
          if (j === lanes.length - 1) {
            evt._lane = j;
          }
        }
      }
    }

    // Within each lane, spread events vertically to avoid overlap.
    // Group by lane, then assign sub-positions.
    var laneGroups = {};
    for (var i = 0; i < this.events.length; i++) {
      var lane = this.events[i]._lane;
      if (!laneGroups[lane]) laneGroups[lane] = [];
      laneGroups[lane].push(this.events[i]);
    }
    for (var lane in laneGroups) {
      var evts = laneGroups[lane];
      for (var k = 0; k < evts.length; k++) {
        evts[k]._subIndex = k;
        evts[k]._subCount = evts.length;
      }
    }
  },

  /**
   * Convert event date to a fractional year for precise positioning.
   */
  _dateToYear: function(evt) {
    // Approximate: year + (month-1)/12 + (day-1)/365
    return evt.event_year + (evt.event_month - 1) / 12 + (evt.event_day - 1) / 365;
  },

  /**
   * Get effective color for an event (override or timeline default).
   */
  _eventColor: function(evt) {
    if (evt.color_override) return evt.color_override;
    return this.timelineColor;
  },

  /**
   * Draw event markers on the timeline.
   */
  _drawEvents: function() {
    var self = this;
    var xScale = this.xScale;
    var yScale = this.yScale;
    var r = this.eventRadius;

    var eventGroups = this.contentGroup.selectAll('.timeline-event')
      .data(this.events)
      .enter()
      .append('g')
      .attr('class', 'timeline-event')
      .attr('transform', function(d) {
        var x = xScale(self._dateToYear(d));
        var laneY = yScale(d._lane) || self.margin.top;
        var bandH = yScale.bandwidth() || self.laneHeight;
        var y = laneY + bandH / 2;
        return 'translate(' + x + ',' + y + ')';
      })
      .style('cursor', 'pointer');

    // Event circle.
    eventGroups.append('circle')
      .attr('r', r)
      .attr('fill', function(d) { return self._eventColor(d); })
      .attr('stroke', 'var(--color-surface, #1a1b26)')
      .attr('stroke-width', 2);

    // Event label (shown when zoomed in enough).
    eventGroups.append('text')
      .attr('x', r + 4)
      .attr('y', 4)
      .attr('class', 'timeline-event-label')
      .text(function(d) {
        return d.label || d.event_name || '';
      });

    // Hover handlers.
    eventGroups
      .on('mouseenter', function(event, d) { self._showTooltip(event, d); })
      .on('mouseleave', function() { self._hideTooltip(); })
      .on('click', function(event, d) { self._onEventClick(event, d); });

    this.eventGroups = eventGroups;
  },

  /**
   * Draw the time axis at the top.
   */
  _drawAxis: function() {
    var xAxis = d3.axisTop(this.xScale)
      .tickFormat(function(d) { return 'Y' + Math.round(d); })
      .ticks(Math.max(2, Math.floor((this.width - this.margin.left - this.margin.right) / 80)));
    this.axisGroup.call(xAxis);
  },

  /**
   * Draw vertical grid lines for each year tick.
   */
  _drawGrid: function() {
    var m = this.margin;
    var contentHeight = this.height - m.top - m.bottom;
    var ticks = this.xScale.ticks(
      Math.max(2, Math.floor((this.width - m.left - m.right) / 80))
    );

    this.gridGroup.selectAll('line').remove();
    this.gridGroup.selectAll('line')
      .data(ticks)
      .enter()
      .append('line')
      .attr('x1', this.xScale)
      .attr('x2', this.xScale)
      .attr('y1', m.top)
      .attr('y2', m.top + contentHeight)
      .attr('stroke', 'var(--color-edge, #2a2b3d)')
      .attr('stroke-dasharray', '2,4')
      .attr('stroke-width', 0.5);
  },

  /**
   * Handle zoom/pan events: rescale axis and reposition events.
   */
  _onZoom: function() {
    var self = this;
    var t = this.currentTransform;

    // Rescale X axis only (horizontal pan/zoom).
    var newX = t.rescaleX(this.xScaleOrig);
    this.xScale = newX;

    // Update axis.
    var xAxis = d3.axisTop(newX)
      .tickFormat(function(d) { return 'Y' + Math.round(d); })
      .ticks(Math.max(2, Math.floor((this.width - this.margin.left - this.margin.right) / 80)));
    this.axisGroup.call(xAxis);

    // Update grid.
    this._drawGrid();

    // Reposition events.
    this.eventGroups.attr('transform', function(d) {
      var x = newX(self._dateToYear(d));
      var laneY = self.yScale(d._lane) || self.margin.top;
      var bandH = self.yScale.bandwidth() || self.laneHeight;
      var y = laneY + bandH / 2;
      return 'translate(' + x + ',' + y + ')';
    });

    // Show/hide labels based on zoom level.
    var pixelsPerYear = Math.abs(newX(1) - newX(0)) * t.k;
    this.eventGroups.selectAll('.timeline-event-label')
      .style('display', pixelsPerYear > 60 ? null : 'none');

    this._updateZoomLabel();
  },

  /**
   * Update the zoom level indicator in the toolbar.
   */
  _updateZoomLabel: function() {
    var label = this.el.querySelector('.timeline-viz-zoom-label');
    if (!label) return;
    var k = this.currentTransform.k;
    var level;
    if (k < 0.3) level = 'Era';
    else if (k < 0.8) level = 'Century';
    else if (k < 2) level = 'Decade';
    else if (k < 8) level = 'Year';
    else if (k < 25) level = 'Month';
    else level = 'Day';
    label.textContent = level;
  },

  /**
   * Programmatic zoom by a scale factor.
   */
  _zoomBy: function(factor) {
    if (!this.svg || !this.zoom) return;
    this.svg.transition().duration(300).call(
      this.zoom.scaleBy, factor
    );
  },

  /**
   * Zoom to fit all events in view.
   */
  _zoomFit: function() {
    if (!this.svg || !this.zoom || this.events.length === 0) return;
    var m = this.margin;
    var w = this.width - m.left - m.right;
    var minYear = d3.min(this.events, function(d) { return d.event_year; }) - 1;
    var maxYear = d3.max(this.events, function(d) { return d.event_year; }) + 1;
    var yearSpan = maxYear - minYear;
    if (yearSpan <= 0) yearSpan = 2;

    // Reset to identity then compute the right transform.
    var scale = w / (this.xScaleOrig(maxYear) - this.xScaleOrig(minYear));
    var tx = m.left - scale * this.xScaleOrig(minYear);

    this.svg.transition().duration(500).call(
      this.zoom.transform,
      d3.zoomIdentity.translate(tx, 0).scale(scale)
    );
  },

  /**
   * Skip to a specific year (centers the view on that year).
   */
  _skipToYear: function() {
    var input = this.el.querySelector('.timeline-viz-skip-input');
    var year = parseInt(input.value, 10);
    if (isNaN(year)) return;

    if (!this.svg || !this.zoom) return;
    var m = this.margin;
    var centerX = (this.width - m.left - m.right) / 2 + m.left;
    var k = this.currentTransform.k;
    var tx = centerX - k * this.xScaleOrig(year);

    this.svg.transition().duration(500).call(
      this.zoom.transform,
      d3.zoomIdentity.translate(tx, 0).scale(k)
    );
    input.value = '';
  },

  /**
   * Show tooltip for an event.
   */
  _showTooltip: function(event, d) {
    var tip = this.tooltip;
    var label = d.label || d.event_name || 'Untitled';
    var date = 'Y' + d.event_year + ' M' + d.event_month + ' D' + d.event_day;
    var lines = ['<strong>' + this._escapeHTML(label) + '</strong>', '<span class="text-fg-muted">' + date + '</span>'];
    if (d.event_entity_name) {
      lines.push('<span class="text-fg-secondary">' +
        (d.event_entity_icon ? '<i class="fa-solid ' + d.event_entity_icon + ' mr-1"></i>' : '') +
        this._escapeHTML(d.event_entity_name) + '</span>');
    }
    if (d.event_category) {
      lines.push('<span class="timeline-viz-tooltip-cat">' + this._escapeHTML(d.event_category) + '</span>');
    }
    if (d.event_description) {
      var desc = d.event_description;
      if (desc.length > 100) desc = desc.substring(0, 100) + '...';
      lines.push('<span class="text-xs text-fg-muted">' + this._escapeHTML(desc) + '</span>');
    }

    tip.innerHTML = lines.join('<br/>');
    tip.style.display = 'block';

    // Position near the mouse.
    var x = event.pageX + 12;
    var y = event.pageY - 10;
    // Keep tooltip on screen.
    var tipW = tip.offsetWidth;
    if (x + tipW > window.innerWidth - 20) {
      x = event.pageX - tipW - 12;
    }
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  },

  /**
   * Hide the tooltip.
   */
  _hideTooltip: function() {
    this.tooltip.style.display = 'none';
  },

  /**
   * Handle click on an event marker.
   * For now, scrolls to the event card if it exists on the page.
   */
  _onEventClick: function(event, d) {
    // Could be extended to open a detail panel or navigate.
    // For now, just show a persistent tooltip.
  },

  /**
   * Escape HTML entities for safe insertion.
   */
  _escapeHTML: function(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /**
   * Destroy the widget and clean up.
   */
  destroy: function() {
    if (this.tooltip && this.tooltip.parentNode) {
      this.tooltip.parentNode.removeChild(this.tooltip);
    }
    if (this.el) {
      this.el.innerHTML = '';
    }
  }
});
