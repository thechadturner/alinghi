import { select, pointer, Selection } from 'd3-selection';
import { drag, DragBehavior } from 'd3-drag';
import robustPnp from 'robust-point-in-polygon';
import { warn } from './console';

interface LassoState {
  possible: boolean;
  selected: boolean;
  hoverSelect: boolean;
  loopSelect: boolean;
  lassoPoint: [number, number];
}

interface LassoEventHandlers {
  start: (event: any) => void;
  draw: (event: any) => void;
  end: (event: any) => void;
}

interface LassoFunction {
  (selection: Selection<SVGElement, any, any, any>): void;
  items: (items?: Selection<any, any, any, any>) => LassoFunction | Selection<any, any, any, any>;
  possibleItems: () => Selection<any, any, any, any>;
  selectedItems: () => Selection<any, any, any, any>;
  notPossibleItems: () => Selection<any, any, any, any>;
  notSelectedItems: () => Selection<any, any, any, any>;
  closePathDistance: (distance?: number) => LassoFunction | number;
  closePathSelect: (select?: boolean) => LassoFunction | boolean;
  isPathClosed: (closed?: boolean) => LassoFunction | boolean;
  hoverSelect: (select?: boolean) => LassoFunction | boolean;
  on: (type?: string, handler?: (event: any) => void) => LassoFunction | LassoEventHandlers | ((event: any) => void);
  targetArea: (area?: Selection<any, any, any, any>) => LassoFunction | Selection<any, any, any, any>;
  getDrawnCoords: () => [number, number][];
  skipDragCalculations: (skip?: boolean) => LassoFunction | boolean;
}

export function lasso(): LassoFunction {
  let items: Selection<any, any, any, any> = select([]);
  let closePathDistance = 75;
  let closePathSelect = true;
  let isPathClosed = false;
  let hoverSelect = true;
  let targetArea: Selection<any, any, any, any> = select('body');
  let on: LassoEventHandlers = { 
    start: (event: any) => {}, 
    draw: (event: any) => {}, 
    end: (event: any) => {} 
  };
  
  // Performance optimization: Throttle expensive calculations
  let lastCalculationTime = 0;
  const calculationThrottle = 16; // ~60fps
  let isCalculating = false; // Flag to prevent overlapping calculations
  let skipDragCalculations = false; // Skip expensive calculations during drag for better performance
  let currentDrawnCoords: [number, number][] = []; // Store drawn coordinates for worker processing

  function lasso(selection: Selection<SVGElement, any, any, any>): void {
    const g = selection.append('g').attr('class', 'lasso');

    // Check theme from DOM (set by themeStore)
    const isDarkMode = typeof document !== 'undefined' && 
      (document.documentElement.classList.contains('dark') || 
       document.documentElement.getAttribute('data-theme') === 'dark');
    
    const strokeColor = isDarkMode ? 'white' : 'black';
    const fillColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(173, 216, 230, 0.5)';
    const strokeColorDark = isDarkMode ? 'rgba(255, 255, 255, 0.8)' : 'darkblue';

    const dynPath = g.append('path')
      .attr('class', 'drawn')
      .style('fill', fillColor)
      .style('stroke', strokeColorDark)
      .style('opacity', 0.5);

    const closePath = g.append('path')
      .attr('class', 'loop_close')
      .style('fill', 'none')
      .style('stroke', strokeColor);

    const originNode = g.append('circle')
      .attr('class', 'origin')
      .attr('r', 2)
      .style('fill', strokeColor);

    let tpath = '';
    let origin: [number, number];
    let torigin: [number, number];
    let drawnCoords: [number, number][] = [];

    const dragBehavior: DragBehavior<Element, any, any> = drag()
      .on('start', dragStart)
      .on('drag', dragMove)
      .on('end', dragEnd);

    // Note: D3's drag behavior internally adds non-passive touch event listeners
    // This causes a browser warning about scroll-blocking events, but it's necessary
    // for D3's drag to work properly (it needs to call preventDefault on touch events)
    // This is expected behavior and doesn't affect functionality
    targetArea.call(dragBehavior);

    // Ensure items is never empty
    if (!items || items.empty()) {
      items = targetArea.selectAll('.lasso-item');
    }

    function dragStart(event: any): void {
      drawnCoords = [];
      currentDrawnCoords = [];
      tpath = '';
      dynPath.attr('d', null);
      closePath.attr('d', null);

      // Performance optimization: Skip expensive position calculations if using worker
      // Positions will be computed lazily when needed (at drag end)
      if (skipDragCalculations) {
        // Minimal initialization - just set up state objects without computing positions
        // This allows immediate lasso drawing without blocking
        Array.from(items.nodes()).forEach((e: any) => {
          e.__lasso = { 
            possible: false, 
            selected: false, 
            hoverSelect: false, 
            loopSelect: false,
            lassoPoint: [0, 0] // Will be computed lazily when needed
          } as LassoState;
        });
      } else {
        // Original behavior: compute positions upfront (for hover selection)
        // Use requestAnimationFrame to defer expensive calculations
        requestAnimationFrame(() => {
          Array.from(items.nodes()).forEach((e: any) => {
            e.__lasso = { 
              possible: false, 
              selected: false, 
              hoverSelect: false, 
              loopSelect: false,
              lassoPoint: [0, 0]
            } as LassoState;
            const box = e.getBoundingClientRect();
            e.__lasso.lassoPoint = [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)];
          });

          if (hoverSelect) {
            items.on('mouseover.lasso', function (this: any) {
              this.__lasso.hoverSelect = true;
            });
          }
        });
      }

      on.start(event);
    }

    function dragMove(event: any): void {
      const targetNode = targetArea.node();
      if (!targetNode) {
        return; // Target area not available, skip this drag move
      }

      // Validate sourceEvent exists and has valid coordinates before calling pointer()
      if (!event.sourceEvent) {
        return; // No source event available
      }

      const x = event.sourceEvent.clientX;
      const y = event.sourceEvent.clientY;

      // Validate client coordinates are finite before attempting coordinate transformation
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        warn('d3-lasso: Invalid client coordinates detected, skipping drag move', { x, y });
        return; // Skip this update if client coordinates are invalid
      }

      // Safely get transformed coordinates with error handling
      let tx: number, ty: number;
      try {
        [tx, ty] = pointer(event.sourceEvent, targetNode);
        // Validate transformed coordinates are finite
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
          warn('d3-lasso: Invalid transformed coordinates detected, skipping drag move', { tx, ty, x, y });
          return;
        }
      } catch (error) {
        warn('d3-lasso: Error transforming coordinates, skipping drag move', { error, x, y });
        return; // Skip this update if coordinate transformation fails
      }

      if (tpath === '') {
        tpath = `M ${tx} ${ty}`;
        origin = [x, y];
        torigin = [tx, ty];
        originNode.attr('cx', tx).attr('cy', ty).attr('display', null);
      } else {
        tpath += ` L ${tx} ${ty}`;
      }

      drawnCoords.push([x, y]);
      // Performance: Only update currentDrawnCoords reference, don't copy array on every move
      // The array is already being built incrementally, so we can just reference it
      currentDrawnCoords = drawnCoords;

      const distance = Math.sqrt((x - origin[0]) ** 2 + (y - origin[1]) ** 2);
      const closeDrawPath = `M ${tx} ${ty} L ${torigin[0]} ${torigin[1]}`;

      dynPath.attr('d', tpath);
      closePath.attr('d', closeDrawPath);

      isPathClosed = distance <= closePathDistance;

      closePath.attr('display', isPathClosed && closePathSelect ? null : 'none');

      // Skip expensive point-in-polygon calculations during drag if flag is set
      // This allows smooth lasso drawing - calculations will be done in worker after drag ends
      if (!skipDragCalculations) {
        // Performance optimization: Throttle expensive calculations and only check when needed
        const now = performance.now();
        if ((isPathClosed || distance <= closePathDistance * 2) && 
            (now - lastCalculationTime) > calculationThrottle && 
            !isCalculating) {
          isCalculating = true;
          lastCalculationTime = now;
          
          // Use requestAnimationFrame to defer expensive calculations
          requestAnimationFrame(() => {
            try {
              items.nodes().forEach((n: any) => {
                if (n && n.__lasso && n.__lasso.lassoPoint) {
                  n.__lasso.loopSelect = isPathClosed && closePathSelect ? robustPnp(drawnCoords, n.__lasso.lassoPoint) < 1 : false;
                  n.__lasso.possible = n.__lasso.hoverSelect || n.__lasso.loopSelect;
                }
              });
            } catch (error) {
              warn('Error in lasso calculation:', error);
            } finally {
              isCalculating = false;
            }
          });
        }
      }

      on.draw(event);
    }

    function dragEnd(event: any): void {
      items.on('mouseover.lasso', null);

      const selectedIds: string[] = [];
      items.nodes().forEach((n: any) => {
        n.__lasso.selected = n.__lasso.possible;
        n.__lasso.possible = false;

        if (n.__lasso.selected) {
          selectedIds.push(n.getAttribute('id'));
          select(n).classed('selected', true);
        } else {
          select(n).classed('selected', false);
        }
      });

      dynPath.attr('d', null);
      closePath.attr('d', null);
      originNode.attr('display', 'none');

      on.end(event);
    }
  }

  lasso.items = function (_?: Selection<any, any, any, any>): LassoFunction | Selection<any, any, any, any> {
    if (!arguments.length) return items;
    items = _!;
    if (!items || items.empty()) {
      items = targetArea.selectAll('.lasso-item');
    }
    items.nodes().forEach((n: any) => {
      n.__lasso = { possible: false, selected: false } as LassoState;
    });
    return lasso;
  };

  lasso.possibleItems = function (): Selection<any, any, any, any> {
    return items.filter(function (this: any) {
      return this.__lasso.possible;
    });
  };

  lasso.selectedItems = function (): Selection<any, any, any, any> {
    return items.filter(function (this: any) {
      return this.__lasso.selected;
    });
  };

  lasso.notPossibleItems = function (): Selection<any, any, any, any> {
    return items.filter(function (this: any) {
      return !this.__lasso.possible;
    });
  };

  lasso.notSelectedItems = function (): Selection<any, any, any, any> {
    return items.filter(function (this: any) {
      return !this.__lasso.selected;
    });
  };

  lasso.closePathDistance = function (_?: number): LassoFunction | number {
    if (!arguments.length) return closePathDistance;
    closePathDistance = Number(_);
    if (isNaN(closePathDistance) || closePathDistance <= 0) {
      closePathDistance = 75;
    }
    return lasso;
  };

  lasso.closePathSelect = function (_?: boolean): LassoFunction | boolean {
    if (!arguments.length) return closePathSelect;
    closePathSelect = _ === true;
    return lasso;
  };

  lasso.isPathClosed = function (_?: boolean): LassoFunction | boolean {
    if (!arguments.length) return isPathClosed;
    isPathClosed = _ === true;
    return lasso;
  };

  lasso.hoverSelect = function (_?: boolean): LassoFunction | boolean {
    if (!arguments.length) return hoverSelect;
    hoverSelect = _ === true;
    return lasso;
  };

  lasso.on = function (type?: string, _?: (event: any) => void): LassoFunction | LassoEventHandlers | ((event: any) => void) {
    if (!arguments.length) return on;
    if (arguments.length === 1) return on[type as keyof LassoEventHandlers];
    const types = ['start', 'draw', 'end'];
    if (types.includes(type!)) {
      (on as any)[type!] = _;
    }
    return lasso;
  };

  lasso.targetArea = function (_?: Selection<any, any, any, any>): LassoFunction | Selection<any, any, any, any> {
    if (!arguments.length) return targetArea;
    targetArea = _!;
    if (!targetArea || targetArea.empty()) {
      targetArea = select('body');
    }
    return lasso;
  };

  lasso.getDrawnCoords = function (): [number, number][] {
    return currentDrawnCoords;
  };

  lasso.skipDragCalculations = function (_?: boolean): LassoFunction | boolean {
    if (!arguments.length) return skipDragCalculations;
    skipDragCalculations = _ === true;
    return lasso;
  };

  return lasso;
}
