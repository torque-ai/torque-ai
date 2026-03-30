/**
 * Tool definitions for SnapScope screenshot capture
 */

const tools = [
  {
    name: 'capture_screenshots',
    description: 'Run SnapScope against a manifest to capture screenshots of WPF or web app views. Returns a report with succeeded/failed counts, file paths, attempt counts, and optional visual comparison results.',
    inputSchema: {
      type: 'object',
      properties: {
        manifest_path: {
          type: 'string',
          description: 'Absolute path to the SnapScope manifest JSON file (e.g. "/path/to/snapscope/manifests/app.json")'
        },
        output_dir: {
          type: 'string',
          description: 'Override the output directory for screenshots. If omitted, uses the manifest\'s outputDir.'
        },
        filter_tag: {
          type: 'string',
          description: 'Capture only views that have this tag (e.g. "dashboard", "sales", "inventory")'
        },
        view_name: {
          type: 'string',
          description: 'Capture a single view by exact name (e.g. "Invoices", "Dashboard Overview")'
        },
        validate: {
          type: 'boolean',
          description: 'Validate the manifest before running captures. Fails early if validation errors are found.',
          default: false
        },
        resume: {
          type: 'boolean',
          description: 'Resume from a prior run — only re-capture views that failed in the previous report.json.',
          default: false
        },
        compare_dir: {
          type: 'string',
          description: 'Absolute path to a baseline screenshot directory. After capture, compares each screenshot against the baseline and generates diff images.'
        },
        compare_baseline: {
          type: 'boolean',
          description: 'Compare captures against saved baseline in the _baseline subdirectory.',
          default: false
        },
        save_baseline: {
          type: 'boolean',
          description: 'Save successful captures as the new baseline for future comparison.',
          default: false
        },
        exclude_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude views by name (e.g. ["Debug Panel", "Dev Tools"])'
        },
        exclude_tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude views with any of these tags (e.g. ["wip", "deprecated"])'
        },
        format: {
          type: 'string',
          enum: ['png', 'jpeg', 'webp'],
          description: 'Override screenshot format (default: png)'
        },
        quality: {
          type: 'number',
          description: 'Override screenshot quality 0-100 (jpeg only)',
          minimum: 0,
          maximum: 100
        },
        html_report: {
          type: 'boolean',
          description: 'Generate a self-contained HTML report alongside report.json',
          default: false
        },
        concurrency: {
          type: 'number',
          description: 'Override parallel capture concurrency (default: adapter-specific, 5 for web, 2 for WPF)'
        },
        quiet: {
          type: 'boolean',
          description: 'Suppress all non-error output',
          default: false
        },
        verbose: {
          type: 'boolean',
          description: 'Include diagnostic output from SnapScope',
          default: false
        },
        dry_run: {
          type: 'boolean',
          description: 'List views that would be captured without actually running captures',
          default: false
        },
        timeout_seconds: {
          type: 'number',
          description: 'CLI execution timeout in seconds (default: 300)',
          default: 300
        }
      },
      required: ['manifest_path']
    }
  },
  {
    name: 'capture_view',
    description: 'Capture a single named view from a SnapScope manifest. Useful for targeted screenshots during development or UI review. Returns the capture result including file path and size.',
    inputSchema: {
      type: 'object',
      properties: {
        manifest_path: {
          type: 'string',
          description: 'Absolute path to the SnapScope manifest JSON file'
        },
        view_name: {
          type: 'string',
          description: 'Exact name of the view to capture (e.g. "Invoices", "Dashboard Overview"). Case-sensitive.'
        },
        output_dir: {
          type: 'string',
          description: 'Override the output directory for the screenshot'
        },
        timeout_seconds: {
          type: 'number',
          description: 'CLI execution timeout in seconds (default: 60)',
          default: 60
        }
      },
      required: ['manifest_path', 'view_name']
    }
  },
  {
    name: 'capture_views',
    description: 'Capture multiple named views from a manifest in a single CLI invocation. More efficient than calling capture_view repeatedly — launches the app once. Returns a report with per-view results.',
    inputSchema: {
      type: 'object',
      properties: {
        manifest_path: {
          type: 'string',
          description: 'Absolute path to the SnapScope manifest JSON file'
        },
        view_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of exact view names to capture (case-sensitive). All must exist in the manifest.'
        },
        output_dir: {
          type: 'string',
          description: 'Override the output directory for screenshots'
        },
        timeout_seconds: {
          type: 'number',
          description: 'CLI execution timeout in seconds (default: 120)',
          default: 120
        }
      },
      required: ['manifest_path', 'view_names']
    }
  },
  {
    name: 'validate_manifest',
    description: 'Validate a SnapScope manifest file without running captures. Checks required fields, valid type, unique view names, valid navigation actions, positive viewport dimensions, diff threshold range, ignore region bounds, and type-specific requirements (exe for WPF, url for web).',
    inputSchema: {
      type: 'object',
      properties: {
        manifest_path: {
          type: 'string',
          description: 'Absolute path to the SnapScope manifest JSON file to validate'
        }
      },
      required: ['manifest_path']
    }
  },
  {
    name: 'peek_ui',
    description: 'Capture a screenshot of a running app window on a remote desktop and return it as an inline image. Use this to visually verify UI changes, spot layout issues, or confirm that a build rendered correctly. Captures individual windows via PrintWindow (no focus stealing). The peek_server.py HTTP service must be running on the remote interactive desktop session. For the canonical first-slice diagnose-and-bundle path, use `peek_diagnose`; `peek_ui` remains the lower-level capture surface.',
    inputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'string',
          description: 'Capture window by process name (e.g. "SpudgetBooks", "deluge", "notepad"). Matches substring, case-insensitive.'
        },
        title: {
          type: 'string',
          description: 'Capture window by title substring (e.g. "Dashboard", "Invoice"). Case-insensitive.'
        },
        host: {
          type: 'string',
          description: 'Name of a registered peek host (default: use default host from registry)'
        },
        list_windows: {
          type: 'boolean',
          description: 'List all visible windows on the remote desktop. Returns process names and titles. Use to discover what is running.',
          default: false
        },
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Image format (default: jpeg). JPEG is smaller and faster; PNG is lossless.',
          default: 'jpeg'
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (default: 80). Lower = smaller file. Ignored for PNG.',
          default: 80,
          minimum: 1,
          maximum: 100
        },
        max_width: {
          type: 'number',
          description: 'Maximum image width in pixels (default: 1920). Images wider than this are resized proportionally.',
          default: 1920
        },
        scale: {
          type: 'number',
          description: 'Scale factor (0.1-1.0). Shorthand for max_width. 0.5 = half size (~960px wide). Default: 1.0 (no scaling).',
          minimum: 0.1,
          maximum: 1.0
        },
        crop: {
          type: 'object',
          description: 'Crop region in pixels. Applied server-side before encoding.',
          properties: {
            x: { type: 'integer', description: 'Left edge X coordinate' },
            y: { type: 'integer', description: 'Top edge Y coordinate' },
            w: { type: 'integer', description: 'Width in pixels' },
            h: { type: 'integer', description: 'Height in pixels' }
          },
          required: ['x', 'y', 'w', 'h']
        },
        save_path: {
          type: 'string',
          description: 'Optional local path to save the screenshot. If omitted, saves to a temp file.'
        },
        save_baseline: {
          type: 'string',
          description: 'Save this capture as a named baseline for future comparison'
        },
        diff_baseline: {
          type: 'string',
          description: 'Compare this capture against a previously saved baseline by name'
        },
        auto_diff: {
          type: 'boolean',
          description: 'Automatically diff against the last capture of the same target',
          default: false
        },
        annotations: {
          type: 'array',
          description: 'Annotations to draw on the captured image',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['rect', 'circle', 'arrow'] },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
              r: { type: 'number' },
              from: {
                type: 'array',
                items: { type: 'number' }
              },
              to: {
                type: 'array',
                items: { type: 'number' }
              },
              color: { type: 'string', default: 'red' },
              label: { type: 'string' }
            },
            required: ['type']
          }
        },
        ocr: {
          type: 'boolean',
          description: 'Run OCR on captured image and return extracted text. Works with crop/region for targeted text extraction.',
          default: false
        },
        ocr_assert: {
          type: 'string',
          description: 'Run OCR and verify extracted text contains this substring (case-insensitive). Returns pass/fail.'
        },
        region: {
          type: 'string',
          description: 'Use a previously saved named region as crop area. Create regions with save_region.'
        },
        save_region: {
          type: 'object',
          description: 'Save a named crop region for this target. Stored in ~/.peek-ui/regions/.',
          properties: {
            name: { type: 'string', description: 'Region name (e.g. "sidebar", "total-display")' },
            x: { type: 'integer', description: 'Left edge X coordinate' },
            y: { type: 'integer', description: 'Top edge Y coordinate' },
            w: { type: 'integer', description: 'Width in pixels' },
            h: { type: 'integer', description: 'Height in pixels' }
          },
          required: ['name', 'x', 'y', 'w', 'h']
        },
        diff_threshold: {
          type: 'number',
          description: 'Diff threshold (0-1). Pixels with RGB distance above this fraction are counted as changed. Default: 0.01',
          default: 0.01,
          minimum: 0,
          maximum: 1
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 30)',
          default: 30
        },
        annotate: {
          type: 'string',
          description: 'Overlay UI Automation element bounding boxes on the screenshot. Set to "true" for all elements, or a comma-separated list of types (e.g. "Button,Edit,Text") to filter. Color-coded by type with labels. Returns both raw and annotated images.',
          default: ''
        }
      }
    }
  },
  {
    name: 'peek_interact',
    description: 'Interact with a remote UI: click, type, scroll, send hotkeys, focus/resize/move/maximize/minimize windows, read/write clipboard, or wait for elements/windows to appear. Supports smart element targeting via UI Automation — specify element name instead of pixel coordinates. Use with peek_ui to verify results after interaction.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'drag', 'type', 'scroll', 'hotkey', 'focus', 'resize', 'move', 'maximize', 'minimize', 'clipboard_get', 'clipboard_set', 'wait_for_element', 'wait_for_window'],
          description: 'Interaction action to perform. drag requires from_x/from_y/to_x/to_y.'
        },
        host: {
          type: 'string',
          description: 'Name of a registered peek host (default: use default host)'
        },
        process: {
          type: 'string',
          description: 'Target window by process name (e.g. "SpudgetBooks")'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        element: {
          type: 'string',
          description: 'Smart targeting: find a UI element by name or automation ID, then interact with it. Uses UI Automation tree lookup. Works with click (clicks element center), type (focuses element then types), and focus.'
        },
        x: {
          type: 'integer',
          description: 'X coordinate (for click/scroll). Absolute screen coords, or relative to window if process/title specified.'
        },
        y: {
          type: 'integer',
          description: 'Y coordinate (for click/scroll)'
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button (for click, default: left)',
          default: 'left'
        },
        double: {
          type: 'boolean',
          description: 'Double-click (for click action)',
          default: false
        },
        text: {
          type: 'string',
          description: 'Text to type (for type action). Supports {Enter}, {Tab}, {Escape}, etc.'
        },
        keys: {
          type: 'string',
          description: 'Hotkey combo (for hotkey action, e.g. "Ctrl+S", "Alt+F4")'
        },
        from_x: {
          type: 'integer',
          description: 'Drag start X (for drag action). Falls back to x if not provided.'
        },
        from_y: {
          type: 'integer',
          description: 'Drag start Y (for drag action). Falls back to y if not provided.'
        },
        to_x: {
          type: 'integer',
          description: 'Drag end X (for drag action)'
        },
        to_y: {
          type: 'integer',
          description: 'Drag end Y (for drag action)'
        },
        duration: {
          type: 'number',
          description: 'Drag duration in seconds (default: 0.3)',
          default: 0.3
        },
        delta: {
          type: 'integer',
          description: 'Scroll amount (for scroll action). Positive=up, negative=down.'
        },
        width: {
          type: 'integer',
          description: 'Window width (for resize action)'
        },
        height: {
          type: 'integer',
          description: 'Window height (for resize action)'
        },
        wait_timeout: {
          type: 'integer',
          description: 'Timeout in ms for wait_for_element/wait_for_window (default: 10000)',
          default: 10000
        },
        poll_interval: {
          type: 'integer',
          description: 'Polling interval in ms for wait actions (default: 500)',
          default: 500
        },
        wait_target: {
          type: 'string',
          description: 'Process or title substring to wait for (wait_for_window). Falls back to process/title params.'
        },
        wait_after: {
          type: 'integer',
          description: 'Milliseconds to wait after action (default: 300)',
          default: 300
        },
        capture_after: {
          type: 'boolean',
          description: 'Capture a screenshot after the interaction and include it in the response',
          default: false
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      },
      required: ['action']
    }
  },
  {
    name: 'peek_elements',
    description: 'Inspect the UI Automation element tree of a remote window. Returns element names, types, automation IDs, positions, and enabled states. Use to discover interactive elements before using peek_interact. Supports type filtering and depth control.',
    inputSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Name of a registered peek host (default: use default host)'
        },
        process: {
          type: 'string',
          description: 'Target window by process name (e.g. "SpudgetBooks")'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        find: {
          type: 'string',
          description: 'Find a specific element by name or automation ID. Returns its position for click targeting.'
        },
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by element types (e.g. ["Button", "Edit", "ComboBox"]). Common types: Button, Edit, Text, ComboBox, CheckBox, RadioButton, List, ListItem, Tab, TabItem, Menu, MenuItem, DataGrid, Pane, Window.'
        },
        depth: {
          type: 'integer',
          description: 'Maximum tree traversal depth (1-10, default: 3). Higher = more elements but slower.',
          default: 3,
          minimum: 1,
          maximum: 10
        },
        parent_name: {
          type: 'string',
          description: 'Scope find to children of element with this name (e.g. "Settings" to search only in Settings tab)'
        },
        parent_automation_id: {
          type: 'string',
          description: 'Scope find to children of element with this automation ID'
        },
        region: {
          type: 'object',
          description: 'Scope find to elements within this bounding box',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            w: { type: 'number' }, h: { type: 'number' }
          }
        },
        index: {
          type: 'integer',
          description: 'When multiple elements match, pick the Nth (0-based)'
        },
        near: {
          type: 'object',
          description: 'Sort matches by distance to point, return closest',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            radius: { type: 'number', description: 'Max distance in pixels' }
          }
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      }
    }
  },
  {
    name: 'peek_hit_test',
    description: 'Find the deepest UI element at specific window coordinates. Returns element details plus parent chain path. Use when you see something at a specific position in a screenshot and want to identify what element it is.',
    inputSchema: {
      type: 'object',
      properties: {
        process: { type: 'string', description: 'Target window by process name' },
        title: { type: 'string', description: 'Target window by title substring' },
        x: { type: 'number', description: 'X coordinate (window-relative)' },
        y: { type: 'number', description: 'Y coordinate (window-relative)' },
        host: { type: 'string', description: 'Peek host name (default: default host)' },
        timeout_seconds: { type: 'number', description: 'HTTP request timeout (default: 15)', default: 15 }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'peek_regression',
    description: 'Batch visual regression testing. Snapshot all visible windows as baselines, then compare current state against them to detect visual changes after code modifications. Use "snapshot" before changes and "compare" after.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['snapshot', 'compare', 'list'],
          description: 'snapshot: capture all windows as baseline. compare: diff current state against baseline. list: show saved snapshots.',
          default: 'compare'
        },
        host: {
          type: 'string',
          description: 'Name of a registered peek host (default: use default host)'
        },
        process: {
          type: 'string',
          description: 'Filter to windows of a specific process (e.g. "SpudgetBooks")'
        },
        snapshot_id: {
          type: 'string',
          description: 'Compare against a specific snapshot instead of the most recent one'
        },
        diff_threshold: {
          type: 'number',
          description: 'Diff threshold (0-1). Default: 0.01',
          default: 0.01,
          minimum: 0,
          maximum: 1
        },
        ignore_regions: {
          type: 'array',
          description: 'Regions to ignore during comparison (e.g. timestamps, animations). Each region is {x, y, w, h} in pixels.',
          items: {
            type: 'object',
            properties: {
              x: { type: 'integer', description: 'Left edge X coordinate' },
              y: { type: 'integer', description: 'Top edge Y coordinate' },
              w: { type: 'integer', description: 'Width in pixels' },
              h: { type: 'integer', description: 'Height in pixels' }
            },
            required: ['x', 'y', 'w', 'h']
          }
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds per window (default: 60)',
          default: 60
        }
      }
    }
  },
  {
    name: 'peek_launch',
    description: 'Launch an application on a remote peek host desktop. Uses the peek_server /process endpoint to start executables in the interactive desktop session. Supports waiting for the app window to appear. Use with peek_ui to verify the app launched correctly.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the executable on the remote host (e.g. "C:\\\\Users\\\\YourName\\\\Projects\\\\MyApp\\\\bin\\\\Debug\\\\MyApp.exe")'
        },
        build: {
          type: 'boolean',
          description: 'Build the project before launching. When true, "path" should be the project directory (not the exe). Detects build system automatically (.csproj → dotnet build, package.json → npm run build).',
          default: false
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command-line arguments to pass to the executable'
        },
        wait_for_window: {
          type: 'boolean',
          description: 'Wait for the application window to appear before returning (default: true)',
          default: true
        },
        timeout: {
          type: 'integer',
          description: 'Seconds to wait for window to appear (default: 15, max: 30)',
          default: 15,
          minimum: 1,
          maximum: 30
        },
        host: {
          type: 'string',
          description: 'Name of a registered peek host (default: use default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 30)',
          default: 30
        }
      },
      required: ['path']
    }
  },
  {
    name: 'peek_discover',
    description: 'Discover launchable projects on a remote peek host. Scans the ~/Projects directory for projects with recognized build systems (.csproj, .sln, package.json, Cargo.toml). Returns project names, paths, types, and pre-built executable paths. Use this before peek_launch to find what apps are available.',
    inputSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Name of a registered peek host (default: use default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      }
    }
  },
  {
    name: 'peek_open_url',
    description: 'Open a URL in the default browser on a remote peek host. Useful for navigating to web apps (e.g. TORQUE dashboard, local dev servers) before capturing with peek_ui. The browser window can then be captured by title or process name.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to open (must be http:// or https://)'
        },
        host: {
          type: 'string',
          description: 'Name of a registered peek host (default: use default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 10)',
          default: 10
        }
      },
      required: ['url']
    }
  },
  {
    name: 'peek_cdp',
    description: 'Chrome DevTools Protocol integration — inspect DOM, execute JavaScript, navigate pages, and read console output in the browser on a peek host. Requires Edge/Chrome; auto-launches with --remote-debugging-port if not running. Actions: status (check if CDP available), ensure (start browser with CDP), targets (list tabs), navigate (go to URL), evaluate (run JS expression), console (read console messages), dom (get DOM tree).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'ensure', 'targets', 'navigate', 'evaluate', 'console', 'dom'],
          description: 'CDP action to perform',
          default: 'status'
        },
        url: {
          type: 'string',
          description: 'URL to navigate to (for navigate action) or to match a tab (for evaluate/console/dom)'
        },
        title: {
          type: 'string',
          description: 'Tab title substring to match (for evaluate/console/dom/navigate)'
        },
        expression: {
          type: 'string',
          description: 'JavaScript expression to evaluate (for evaluate action)'
        },
        depth: {
          type: 'number',
          description: 'DOM tree depth (for dom action, default: 3)',
          default: 3
        },
        port: {
          type: 'number',
          description: 'CDP port (default: 9222)',
          default: 9222
        },
        host: {
          type: 'string',
          description: 'Name of a registered peek host (default: use default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      }
    }
  },
  {
    name: 'peek_refresh',
    description: 'Refresh the active browser tab on a remote peek host. Sends F5 (or Ctrl+Shift+R for hard refresh) to the browser window. If no process/title is specified, auto-detects the first browser window (Edge, Chrome, Firefox).',
    inputSchema: {
      type: 'object',
      properties: {
        hard: {
          type: 'boolean',
          description: 'Hard refresh (Ctrl+Shift+R) to bypass cache (default: false)',
          default: false
        },
        process: {
          type: 'string',
          description: 'Target browser by process name (e.g. "msedge", "chrome")'
        },
        title: {
          type: 'string',
          description: 'Target browser by window title substring'
        },
        host: {
          type: 'string',
          description: 'Name of a registered peek host (default: use default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 10)',
          default: 10
        }
      }
    }
  },
  {
    name: 'peek_health_all',
    description: 'Check health of all registered peek hosts in parallel. Returns a summary table with reachability, latency, and version for each host. Use at session start to see which hosts are available.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'peek_build_and_open',
    description: 'Build a project, open a URL in a browser on a peek host, wait for page load, and capture a screenshot — all in one tool call. Collapses the common build→open→wait→capture workflow into a single round-trip. Returns the captured screenshot inline.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to open after building (must be http:// or https://)'
        },
        build_command: {
          type: 'string',
          description: 'Shell command to run before opening the URL (e.g. "npm run build"). Omit to skip building.'
        },
        working_directory: {
          type: 'string',
          description: 'Working directory for the build command'
        },
        build_timeout: {
          type: 'number',
          description: 'Build timeout in seconds (default: 60)',
          default: 60
        },
        wait_seconds: {
          type: 'number',
          description: 'Seconds to wait after opening URL before capture (default: 3)',
          default: 3
        },
        capture: {
          type: 'boolean',
          description: 'Whether to capture a screenshot after opening (default: true)',
          default: true
        },
        capture_process: {
          type: 'string',
          description: 'Capture browser by process name (e.g. "msedge"). Auto-detects if omitted.'
        },
        capture_title: {
          type: 'string',
          description: 'Capture browser by window title substring'
        },
        host: {
          type: 'string',
          description: 'Name of a registered peek host (default: use default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout for capture in seconds (default: 30)',
          default: 30
        }
      },
      required: ['url']
    }
  },
  {
    name: 'register_peek_host',
    description: 'Register or update a peek host for remote UI capture routing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique host name used to identify this peek host.'
        },
        url: {
          type: 'string',
          description: 'Base HTTP URL for the peek server (for example "http://192.0.2.100:9876").'
        },
        ssh: {
          type: 'string',
          description: 'Optional SSH connection string for the host.'
        },
        default: {
          type: 'boolean',
          description: 'Whether this host should become the default peek host.',
          default: false
        },
        platform: {
          type: 'string',
          enum: ['windows', 'macos', 'linux'],
          description: 'Optional host platform.'
        }
      },
      required: ['name', 'url']
    }
  },
  {
    name: 'unregister_peek_host',
    description: 'Remove a previously registered peek host by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Registered peek host name to remove.'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'list_peek_hosts',
    description: 'List registered peek hosts and ping each host for health status.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'peek_diagnose',
    description: 'Canonical first-slice diagnose-and-bundle path. Captures screenshot, annotated screenshot with element overlays, element tree, layout measurements (spacing/alignment between elements), and text content summary for a window. Returns everything an LLM needs to diagnose UI issues in a single round-trip. Much more efficient than calling peek_ui + peek_elements + OCR separately.',
    inputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'string',
          description: 'Target window by process name (e.g. "SpudgetBooks", "Taskmgr")'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        screenshot: {
          type: 'boolean',
          description: 'Include screenshots (default: true). Set false for text/element-only diagnosis — much cheaper in tokens.',
          default: true
        },
        annotate: {
          type: 'boolean',
          description: 'Include annotated screenshot with element bounding box overlays (default: true)',
          default: true
        },
        text_content: {
          type: 'boolean',
          description: 'Include deep text extraction (default: true)',
          default: true
        },
        elements: {
          type: 'boolean',
          description: 'Include element tree in response (default: true)',
          default: true
        },
        element_depth: {
          type: 'integer',
          description: 'Element tree traversal depth (default: 4)',
          default: 4,
          minimum: 1,
          maximum: 10
        },
        measurements: {
          type: 'boolean',
          description: 'Include layout measurements — spacing and alignment between sibling elements (default: true)',
          default: true
        },
        crop_element: {
          type: 'string',
          description: 'Crop screenshot to a specific UI element by name (with 10px padding). Use to focus on a particular area.'
        },
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Image format (default: jpeg)',
          default: 'jpeg'
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (default: 80)',
          default: 80,
          minimum: 1,
          maximum: 100
        },
        max_width: {
          type: 'number',
          description: 'Maximum image width in pixels (default: 1920)',
          default: 1920
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 30)',
          default: 30
        }
      }
    }
  },
  {
    name: 'peek_semantic_diff',
    description: 'Compare a baseline UI Automation element tree against the current live state of a window. Detects added, removed, moved, resized, and text-changed elements. Use this after making UI changes to see exactly what shifted. Pass baseline_elements from a previous peek_elements or peek_diagnose call. Returns structured diff with per-element change details.',
    inputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'string',
          description: 'Target window by process name (e.g. "SpudgetBooks", "Taskmgr")'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        baseline_elements: {
          type: 'array',
          description: 'Baseline element tree from a previous peek_elements or peek_diagnose call. Each element should have name, type, bounds, and optionally automation_id, value, children.',
          items: { type: 'object' }
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        depth: {
          type: 'integer',
          description: 'Element tree traversal depth for current snapshot (default: 4)',
          default: 4,
          minimum: 1,
          maximum: 10
        },
        match_strategy: {
          type: 'string',
          enum: ['name+type', 'automation_id'],
          description: 'How to match baseline and current elements (default: name+type)',
          default: 'name+type'
        },
        include_screenshot: {
          type: 'boolean',
          description: 'Include a screenshot of the current window state (default: false)',
          default: false
        },
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Screenshot format if include_screenshot is true (default: jpeg)',
          default: 'jpeg'
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 if include_screenshot is true (default: 80)',
          default: 80,
          minimum: 1,
          maximum: 100
        },
        max_width: {
          type: 'number',
          description: 'Maximum screenshot width in pixels (default: 1920)',
          default: 1920
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 30)',
          default: 30
        }
      },
      required: ['baseline_elements']
    }
  },
  {
    name: 'peek_wait',
    description: 'Wait for UI conditions to be met before proceeding. Polls the element tree until conditions match or timeout. Use before capturing to ensure async UI has settled. Conditions: element_exists, element_gone, text_contains, text_gone, element_count, element_enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'string',
          description: 'Target window by process name'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        conditions: {
          type: 'array',
          description: 'Conditions to wait for. Each has a "type" key: element_exists, element_gone, text_contains, text_gone, element_count, element_enabled. Examples: {"type":"element_exists","name":"Save"}, {"type":"text_contains","text":"Success"}, {"type":"element_count","element_type":"ListItem","min":3}',
          items: { type: 'object' }
        },
        wait_timeout: {
          type: 'number',
          description: 'Max seconds to wait for conditions (default: 10)',
          default: 10
        },
        poll_interval: {
          type: 'number',
          description: 'Seconds between polls (default: 0.25)',
          default: 0.25
        },
        match_mode: {
          type: 'string',
          enum: ['all', 'any'],
          description: 'Whether all conditions must be met or just any one (default: all)',
          default: 'all'
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 30)',
          default: 30
        }
      },
      required: ['conditions']
    }
  },
  {
    name: 'peek_action_sequence',
    description: 'Execute a multi-step UI interaction sequence in a single round-trip. Steps run atomically in order: click, type, hotkey, scroll, wait, sleep, capture, focus. Returns per-step results plus any captured screenshots. Use instead of multiple peek_interact + peek_wait + peek_ui calls.',
    inputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'string',
          description: 'Target window by process name'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        steps: {
          type: 'array',
          description: 'Ordered list of action steps. Each has an "action" key: click, type, hotkey, scroll, wait, sleep, capture, focus. Examples: {"action":"click","element":"Save"}, {"action":"wait","conditions":[{"type":"text_contains","text":"Saved"}]}, {"action":"capture"}. Add "continue_on_error":true to skip failures.',
          items: { type: 'object' }
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 60)',
          default: 60
        }
      },
      required: ['steps']
    }
  },
  {
    name: 'peek_ocr',
    description: 'Run OCR text extraction on a window screenshot. Use when UIA elements cannot see the text (canvas, WebView, terminals, custom-rendered content). Returns structured text with word/line bounding boxes and confidence scores. Requires Tesseract OCR installed on the peek host.',
    inputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'string',
          description: 'Target window by process name'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        region: {
          type: 'object',
          description: 'Optional region to OCR (x, y, w, h). If omitted, OCR runs on the full screenshot.',
          properties: {
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
            w: { type: 'number', description: 'Width' },
            h: { type: 'number', description: 'Height' }
          },
          required: ['x', 'y', 'w', 'h']
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      }
    }
  },
  {
    name: 'peek_color',
    description: 'Sample pixel colors from a window screenshot. Either provide specific (x,y) points, or an element name to sample center + 4 corners. Returns RGB values and hex codes. Use to verify background colors, theme consistency, or debug rendering.',
    inputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'string',
          description: 'Target window by process name'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        points: {
          type: 'array',
          description: 'List of {x, y} coordinates to sample',
          items: {
            type: 'object',
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' }
            },
            required: ['x', 'y']
          }
        },
        element: {
          type: 'string',
          description: 'Element name — samples center + 4 corners of the element bounds'
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      }
    }
  },
  {
    name: 'peek_snapshot',
    description: 'Save or diff server-side element tree snapshots. Save a snapshot before making changes, then diff against it after. The diff uses semantic comparison (added/removed/moved/resized/text_changed). Snapshot is consumed (deleted) on diff. Use for lightweight before/after comparison without storing baselines locally.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'diff', 'list', 'clear'],
          description: 'save: capture element tree. diff: compare current vs saved (consumes snapshot). list: show saved labels. clear: delete all.',
          default: 'save'
        },
        label: {
          type: 'string',
          description: 'Snapshot label (required for save/diff). Use descriptive names like "before-resize" or "settings-tab".'
        },
        process: {
          type: 'string',
          description: 'Target window by process name'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        depth: {
          type: 'integer',
          description: 'Element tree depth (default: 4)',
          default: 4,
          minimum: 1,
          maximum: 10
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      }
    }
  },
  {
    name: 'peek_table',
    description: 'Extract structured table/grid data from a List or DataGrid element. Returns column headers, rows with cell values, row count, and selected rows. Use when you need to read tabular data from a UI without screenshots.',
    inputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'string',
          description: 'Target window by process name'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        table_name: {
          type: 'string',
          description: 'Find table by element name'
        },
        table_automation_id: {
          type: 'string',
          description: 'Find table by automation ID'
        },
        table_type: {
          type: 'string',
          description: 'Element type to search for (default: DataGrid, falls back to List)',
          default: 'DataGrid'
        },
        depth: {
          type: 'integer',
          description: 'Element tree depth (default: 5)',
          default: 5,
          minimum: 1,
          maximum: 10
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      }
    }
  },
  {
    name: 'peek_summary',
    description: 'Get a compact text-only summary of a window — buttons, inputs, tabs, lists, visible text, element count. Zero screenshots, minimal tokens. Use for cheap state checks, deciding what to interact with, or confirming navigation worked. Much faster and cheaper than peek_diagnose.',
    inputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'string',
          description: 'Target window by process name'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        depth: {
          type: 'integer',
          description: 'Element tree traversal depth (default: 4)',
          default: 4,
          minimum: 1,
          maximum: 10
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      }
    }
  },
  {
    name: 'peek_assert',
    description: 'Run declarative UI assertions against a window. Verify element existence, enabled/disabled state, toggle state, text content, element counts, and expand/collapse state — all in a single call. Returns structured pass/fail results. Use instead of peek_elements + manual checking.',
    inputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'string',
          description: 'Target window by process name'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        assertions: {
          type: 'array',
          description: 'List of assertions to evaluate. Each has a "type" key. Types: element_exists, element_not_exists, element_enabled, element_disabled, text_contains, text_equals, element_count, toggle_state, expand_state, element_visible. Examples: {"type":"element_exists","name":"Save"}, {"type":"toggle_state","automation_id":"MyToggle","expected_state":"on"}, {"type":"element_count","element_type":"ListItem","min":3}.',
          items: { type: 'object' }
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      },
      required: ['assertions']
    }
  },
  {
    name: 'peek_recovery',
    description: 'Execute a recovery action on a peek host. Validates the action against the host\'s allowed-action list, evaluates policy engine rules (shadow/canary/live mode), tracks retry budgets, and produces rollback plans. Returns structured result with success/failure, policy proof, and rollback plan.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Recovery action name (e.g. "reset_window_position", "restart_process", "clear_cache")'
        },
        params: {
          type: 'object',
          description: 'Action-specific parameters passed to the recovery endpoint'
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        retry_count: {
          type: 'integer',
          description: 'Current retry attempt number (checked against action max_retries budget)',
          default: 0,
          minimum: 0
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      },
      required: ['action']
    }
  },
  {
    name: 'peek_recovery_status',
    description: 'Query a peek host for its recovery capabilities — allowed actions, retry budgets, and stop conditions. Use before peek_recovery to discover what recovery actions are available.',
    inputSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      }
    }
  },
  {
    name: 'peek_onboard',
    description: 'Get the reference onboarding guide for peek-supported app types (WPF, Win32, Electron/WebView2). Returns capabilities, recommended diagnostic options, and step-by-step onboarding instructions. Use before first peek_diagnose call on a new application.',
    inputSchema: {
      type: 'object',
      properties: {
        app_type: {
          type: 'string',
          enum: ['wpf', 'win32', 'electron_webview'],
          description: 'Filter to a specific app type. If omitted, returns all supported types.'
        }
      }
    }
  },
  {
    name: 'peek_onboard_detect',
    description: 'Detect the app type of a running window on a peek host. Queries the host for window information and classifies the framework (WPF, Win32, or Electron). Returns the matching capability catalog and recommended next step.',
    inputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'string',
          description: 'Target window by process name (e.g. "LedgerPro.Desktop")'
        },
        title: {
          type: 'string',
          description: 'Target window by title substring'
        },
        host: {
          type: 'string',
          description: 'Peek host name (default: default host)'
        },
        timeout_seconds: {
          type: 'number',
          description: 'HTTP request timeout in seconds (default: 15)',
          default: 15
        }
      }
    }
  }
];

module.exports = tools;
