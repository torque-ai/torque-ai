'use strict';

const {
  PEEK_AUTHORITATIVE_PACKAGE_ROOT,
  PEEK_CAPABILITIES_ROUTES = {},
  PEEK_FIRST_SLICE_NAME,
  PEEK_INVESTIGATION_BUNDLE_CONTRACT,
} = require('./peek') || {};

const FIXED_CREATED_AT = '2026-03-10T00:00:00Z';
const FIXED_RUNTIME_VERSION = '19.0.0';
const FIXED_HOST = 'peek-winlab-01';

function encodeBase64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function createImageBlob(label) {
  return {
    present: true,
    encoding: 'base64',
    mime_type: 'image/png',
    data: encodeBase64(label),
  };
}

function countTreeNodes(nodes) {
  if (Array.isArray(nodes)) {
    return nodes.reduce((total, node) => total + countTreeNodes(node), 0);
  }

  if (!nodes || typeof nodes !== 'object') {
    return 0;
  }

  return 1 + countTreeNodes(Array.isArray(nodes.children) ? nodes.children : []);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function buildFixture({
  appType,
  hwnd,
  locator,
  title,
  processName,
  captureData,
  metadata,
  elementsTree,
  measurements,
  textContent,
  annotationIndex,
  extras,
}) {
  return deepFreeze({
    contract: { ...PEEK_INVESTIGATION_BUNDLE_CONTRACT },
    kind: 'diagnose',
    slice: PEEK_FIRST_SLICE_NAME,
    created_at: FIXED_CREATED_AT,
    app_type: appType,
    runtime: {
      name: 'peek-server',
      version: FIXED_RUNTIME_VERSION,
      platform: 'windows',
      package_root: PEEK_AUTHORITATIVE_PACKAGE_ROOT,
    },
    request: {
      route: PEEK_CAPABILITIES_ROUTES.investigation_bundle,
      options: {
        hwnd,
        process: processName,
        title,
        format: 'png',
        annotate: true,
        elements: true,
        measurements: true,
        text_content: true,
        max_width: captureData.width,
      },
    },
    target: {
      hwnd,
      locator: { ...locator },
    },
    result: {
      success: true,
      error: null,
      warnings: [],
    },
    artifacts: {
      persisted: false,
      bundle_path: null,
      artifact_report_path: null,
      signed: false,
    },
    evidence: {
      screenshot: createImageBlob(`${appType}-screenshot`),
      annotated_screenshot: createImageBlob(`${appType}-annotated-screenshot`),
      elements: {
        count: countTreeNodes(elementsTree),
        tree: elementsTree,
      },
      measurements,
      text_content: textContent,
      annotation_index: annotationIndex,
    },
    capture_data: captureData,
    metadata,
    ...extras,
  });
}

const WPF_FIXTURE = buildFixture({
  appType: 'wpf',
  hwnd: 1056820,
  locator: {
    type: 'title',
    value: 'LedgerPro - Quarter Close',
  },
  title: 'LedgerPro - Quarter Close',
  processName: 'LedgerPro.Desktop.exe',
  captureData: {
    provider: 'dxgi',
    host: FIXED_HOST,
    process_name: 'LedgerPro.Desktop.exe',
    window_title: 'LedgerPro - Quarter Close',
    image_base64: encodeBase64('wpf-window-capture'),
    pixel_format: 'bgra8',
    width: 1440,
    height: 900,
    scale_factor: 1.25,
    window_bounds: { x: 120, y: 64, w: 1440, h: 900 },
    client_bounds: { x: 128, y: 96, w: 1424, h: 844 },
    focused_element: 'ClosePeriodButton',
  },
  metadata: {
    host: FIXED_HOST,
    process_name: 'LedgerPro.Desktop.exe',
    window_title: 'LedgerPro - Quarter Close',
    framework: 'WPF',
    main_class_name: 'HwndWrapper[LedgerPro.Desktop;;ledgerpro-shell]',
    executable_path: 'C:/Program Files/LedgerPro/LedgerPro.Desktop.exe',
    automation_framework: 'UIAutomation',
    dpi_awareness: 'per_monitor_v2',
  },
  elementsTree: [
    {
      name: 'Quarter Close',
      type: 'Window',
      automation_id: 'QuarterCloseWindow',
      class_name: 'HwndWrapper[LedgerPro.Desktop;;ledgerpro-shell]',
      bounds: { x: 120, y: 64, w: 1440, h: 900 },
      children: [
        {
          name: 'Quarter Close Layout',
          type: 'Grid',
          automation_id: 'QuarterCloseLayout',
          class_name: 'Grid',
          bounds: { x: 144, y: 112, w: 1392, h: 796 },
          children: [
            {
              name: 'Fiscal Period',
              type: 'ComboBox',
              automation_id: 'PeriodSelector',
              class_name: 'ComboBox',
              bounds: { x: 220, y: 148, w: 220, h: 32 },
              children: [],
            },
            {
              name: 'Validation Issues',
              type: 'DataGrid',
              automation_id: 'ValidationGrid',
              class_name: 'DataGrid',
              bounds: { x: 220, y: 248, w: 940, h: 380 },
              children: [],
            },
            {
              name: 'Close Period',
              type: 'Button',
              automation_id: 'ClosePeriodButton',
              class_name: 'Button',
              bounds: { x: 1184, y: 796, w: 176, h: 40 },
              children: [],
            },
          ],
        },
      ],
    },
  ],
  measurements: {
    window_size: { w: 1440, h: 900 },
    element_summary: [
      {
        name: 'Quarter Close',
        type: 'Window',
        bounds: { x: 120, y: 64, w: 1440, h: 900 },
      },
      {
        name: 'Validation Issues',
        type: 'DataGrid',
        bounds: { x: 220, y: 248, w: 940, h: 380 },
      },
    ],
    spacing: [
      {
        from: 'PeriodSelector',
        to: 'ValidationGrid',
        axis: 'vertical',
        distance: 68,
      },
    ],
  },
  textContent: {
    buttons: ['Close Period', 'Post Entries'],
    labels: ['Fiscal Period', 'Validation Issues', 'Review Status'],
    inputs: [
      {
        label: 'Prepared By',
        value: 'Taylor Morgan',
      },
    ],
    lists: [
      {
        name: 'Validation Issues',
        item_count: 4,
      },
    ],
  },
  annotationIndex: [
    {
      index: 1,
      label: 'Validation Issues',
      bounds: { x: 220, y: 248, w: 940, h: 380 },
    },
    {
      index: 2,
      label: 'Close Period',
      bounds: { x: 1184, y: 796, w: 176, h: 40 },
    },
  ],
  extras: {
    visual_tree: {
      format: 'xaml',
      root: {
        xaml_type: 'LedgerPro.Views.QuarterCloseWindow',
        name: 'QuarterCloseWindow',
        automation_id: 'QuarterCloseWindow',
        properties: {
          title: 'Quarter Close',
          window_startup_location: 'CenterScreen',
        },
        children: [
          {
            xaml_type: 'Grid',
            name: 'QuarterCloseLayout',
            children: [
              {
                xaml_type: 'ComboBox',
                name: 'PeriodSelector',
                binding: 'SelectedPeriod',
              },
              {
                xaml_type: 'DataGrid',
                name: 'ValidationGrid',
                items_source: 'ValidationMessages',
              },
              {
                xaml_type: 'Button',
                name: 'ClosePeriodButton',
                command: 'ClosePeriodCommand',
              },
            ],
          },
        ],
      },
    },
    property_bag: {
      DataContext: 'LedgerPro.ViewModels.QuarterCloseViewModel',
      WindowState: 'Normal',
      ResizeMode: 'CanResize',
      SelectedPeriod: '2026-Q1',
      PendingJournalCount: 4,
      CanClosePeriod: true,
    },
    performance_counters: {
      cpu_percent: 2.4,
      memory_bytes: 187_400_192,
      handle_count: 342,
      thread_count: 18,
      uptime_seconds: 3847,
    },
  },
});

const WIN32_FIXTURE = buildFixture({
  appType: 'win32',
  hwnd: 594658,
  locator: {
    type: 'hwnd',
    value: 594658,
  },
  title: 'Print Queue Manager',
  processName: 'spoolview.exe',
  captureData: {
    provider: 'gdi',
    host: FIXED_HOST,
    process_name: 'spoolview.exe',
    window_title: 'Print Queue Manager',
    image_base64: encodeBase64('win32-window-capture'),
    pixel_format: 'bgra8',
    width: 1280,
    height: 720,
    scale_factor: 1,
    window_bounds: { x: 88, y: 82, w: 1280, h: 720 },
    client_bounds: { x: 96, y: 114, w: 1264, h: 656 },
    focused_element: 'PausePrinterButton',
  },
  metadata: {
    host: FIXED_HOST,
    process_name: 'spoolview.exe',
    window_title: 'Print Queue Manager',
    framework: 'Win32',
    main_class_name: 'PrintQueueWnd',
    executable_path: 'C:/Program Files/PrintOps/spoolview.exe',
    integrity_level: 'medium',
    dpi_awareness: 'system_aware',
  },
  elementsTree: [
    {
      name: 'Print Queue Manager',
      type: 'Window',
      automation_id: 'MainWindow',
      class_name: 'PrintQueueWnd',
      bounds: { x: 88, y: 82, w: 1280, h: 720 },
      children: [
        {
          name: 'QueueToolbar',
          type: 'ToolBar',
          automation_id: 'QueueToolbar',
          class_name: 'ToolbarWindow32',
          bounds: { x: 104, y: 124, w: 1240, h: 34 },
          children: [],
        },
        {
          name: 'Jobs',
          type: 'List',
          automation_id: 'JobList',
          class_name: 'SysListView32',
          bounds: { x: 104, y: 174, w: 1240, h: 454 },
          children: [],
        },
        {
          name: 'Pause Printer',
          type: 'Button',
          automation_id: 'PausePrinterButton',
          class_name: 'Button',
          bounds: { x: 1124, y: 642, w: 180, h: 34 },
          children: [],
        },
      ],
    },
  ],
  measurements: {
    window_size: { w: 1280, h: 720 },
    element_summary: [
      {
        name: 'QueueToolbar',
        type: 'ToolBar',
        bounds: { x: 104, y: 124, w: 1240, h: 34 },
      },
      {
        name: 'Jobs',
        type: 'List',
        bounds: { x: 104, y: 174, w: 1240, h: 454 },
      },
    ],
    spacing: [
      {
        from: 'QueueToolbar',
        to: 'JobList',
        axis: 'vertical',
        distance: 16,
      },
    ],
  },
  textContent: {
    buttons: ['Pause Printer', 'Resume Printer'],
    labels: ['Printer: Floor 2 Color', 'Status: Ready'],
    inputs: [],
    lists: [
      {
        name: 'Jobs',
        item_count: 5,
      },
    ],
  },
  annotationIndex: [
    {
      index: 1,
      label: 'Jobs',
      bounds: { x: 104, y: 174, w: 1240, h: 454 },
    },
    {
      index: 2,
      label: 'Pause Printer',
      bounds: { x: 1124, y: 642, w: 180, h: 34 },
    },
  ],
  extras: {
    hwnd_metadata: {
      handle_hex: '0x000912E2',
      owner_pid: 8428,
      owner_thread_id: 11544,
      class_atom: '0xC0A1',
      styles: ['WS_OVERLAPPEDWINDOW', 'WS_VISIBLE', 'WS_CLIPCHILDREN'],
      ex_styles: ['WS_EX_APPWINDOW', 'WS_EX_WINDOWEDGE'],
      menu_handle_hex: '0x00000000',
    },
    class_name_chain: ['PrintQueueWnd', 'ReBarWindow32', 'ToolbarWindow32', 'SysListView32', 'Button'],
    performance_counters: {
      cpu_percent: 0.8,
      memory_bytes: 42_598_400,
      handle_count: 156,
      thread_count: 6,
      uptime_seconds: 12044,
    },
  },
});

const ELECTRON_FIXTURE = buildFixture({
  appType: 'electron_webview',
  hwnd: 881104,
  locator: {
    type: 'process',
    value: 'ContosoOps.exe',
  },
  title: 'Contoso Ops Dashboard',
  processName: 'ContosoOps.exe',
  captureData: {
    provider: 'desktop-duplication',
    host: FIXED_HOST,
    process_name: 'ContosoOps.exe',
    window_title: 'Contoso Ops Dashboard',
    image_base64: encodeBase64('electron-window-capture'),
    pixel_format: 'bgra8',
    width: 1600,
    height: 960,
    scale_factor: 1,
    window_bounds: { x: 160, y: 40, w: 1600, h: 960 },
    client_bounds: { x: 168, y: 72, w: 1584, h: 912 },
    focused_element: 'RefreshButton',
  },
  metadata: {
    host: FIXED_HOST,
    process_name: 'ContosoOps.exe',
    window_title: 'Contoso Ops Dashboard',
    framework: 'Electron',
    main_class_name: 'Chrome_WidgetWin_1',
    executable_path: 'C:/Program Files/ContosoOps/ContosoOps.exe',
    webview_backend: 'WebView2',
    entry_url: 'app://ops-dashboard/index.html#/incidents',
  },
  elementsTree: [
    {
      name: 'Contoso Ops Dashboard',
      type: 'Window',
      automation_id: 'MainWindow',
      class_name: 'Chrome_WidgetWin_1',
      bounds: { x: 160, y: 40, w: 1600, h: 960 },
      children: [
        {
          name: 'Navigation Rail',
          type: 'Pane',
          automation_id: 'NavRail',
          class_name: 'Chrome_RenderWidgetHostHWND',
          bounds: { x: 184, y: 112, w: 216, h: 824 },
          children: [],
        },
        {
          name: 'Open Incidents Grid',
          type: 'Table',
          automation_id: 'incident-grid',
          class_name: 'Chrome_RenderWidgetHostHWND',
          bounds: { x: 432, y: 180, w: 1184, h: 644 },
          children: [],
        },
        {
          name: 'Refresh',
          type: 'Button',
          automation_id: 'RefreshButton',
          class_name: 'Button',
          bounds: { x: 1468, y: 126, w: 124, h: 36 },
          children: [],
        },
      ],
    },
  ],
  measurements: {
    window_size: { w: 1600, h: 960 },
    element_summary: [
      {
        name: 'Navigation Rail',
        type: 'Pane',
        bounds: { x: 184, y: 112, w: 216, h: 824 },
      },
      {
        name: 'Open Incidents Grid',
        type: 'Table',
        bounds: { x: 432, y: 180, w: 1184, h: 644 },
      },
    ],
    spacing: [
      {
        from: 'NavRail',
        to: 'incident-grid',
        axis: 'horizontal',
        distance: 32,
      },
    ],
  },
  textContent: {
    buttons: ['Refresh', 'Acknowledge'],
    labels: ['Open Incidents', 'Search incidents'],
    inputs: [
      {
        label: 'Search incidents',
        value: 'router 4',
      },
    ],
    lists: [
      {
        name: 'Open Incidents Grid',
        item_count: 8,
      },
    ],
  },
  annotationIndex: [
    {
      index: 1,
      label: 'Open Incidents Grid',
      bounds: { x: 432, y: 180, w: 1184, h: 644 },
    },
    {
      index: 2,
      label: 'Refresh',
      bounds: { x: 1468, y: 126, w: 124, h: 36 },
    },
  ],
  extras: {
    devtools_protocol: {
      browser: 'Edg/122.0.2365.92',
      protocol_version: '1.3',
      target_id: 'target-contoso-ops-dashboard',
      session_id: 'session-contoso-ops-dashboard',
      user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ContosoOps/1.4.2 Chrome/122.0.6261.95 Electron/30.1.0 Safari/537.36',
      web_socket_debugger_url: 'ws://127.0.0.1:9222/devtools/page/target-contoso-ops-dashboard',
    },
    dom_snapshot: {
      document_url: 'app://ops-dashboard/index.html#/incidents',
      document_title: 'Contoso Ops Dashboard',
      root: {
        node_name: 'BODY',
        attributes: {
          'data-app': 'ops-dashboard',
          'data-route': '/incidents',
        },
        children: [
          {
            node_name: 'NAV',
            attributes: {
              id: 'nav-rail',
            },
            text_content: 'Incidents Alerts Reports',
          },
          {
            node_name: 'MAIN',
            attributes: {
              id: 'incident-view',
            },
            children: [
              {
                node_name: 'H1',
                text_content: 'Open Incidents',
              },
              {
                node_name: 'TABLE',
                attributes: {
                  id: 'incident-grid',
                },
                row_count: 8,
              },
            ],
          },
        ],
      },
    },
    performance_counters: {
      cpu_percent: 5.1,
      memory_bytes: 312_475_648,
      handle_count: 891,
      thread_count: 42,
      uptime_seconds: 1523,
    },
  },
});

const WINFORMS_FIXTURE = buildFixture({
  appType: 'winforms',
  hwnd: 734912,
  locator: {
    type: 'title',
    value: 'Inventory Tracker - Warehouse A',
  },
  title: 'Inventory Tracker - Warehouse A',
  processName: 'InventoryTracker.exe',
  captureData: {
    provider: 'gdi',
    host: FIXED_HOST,
    process_name: 'InventoryTracker.exe',
    window_title: 'Inventory Tracker - Warehouse A',
    image_base64: encodeBase64('winforms-window-capture'),
    pixel_format: 'bgra8',
    width: 1366,
    height: 768,
    scale_factor: 1,
    window_bounds: { x: 104, y: 88, w: 1366, h: 768 },
    client_bounds: { x: 112, y: 120, w: 1350, h: 712 },
    focused_element: 'InventoryGrid',
  },
  metadata: {
    host: FIXED_HOST,
    process_name: 'InventoryTracker.exe',
    window_title: 'Inventory Tracker - Warehouse A',
    framework: 'WinForms',
    main_class_name: 'WindowsForms10.Window.8.app.0.33c0d9d',
    executable_path: 'C:/Program Files/InventoryTracker/InventoryTracker.exe',
    automation_framework: 'UIAutomation',
    dpi_awareness: 'system_aware',
  },
  elementsTree: [
    {
      name: 'Inventory Tracker - Warehouse A',
      type: 'Window',
      automation_id: 'MainForm',
      class_name: 'WindowsForms10.Window.8.app.0.33c0d9d',
      bounds: { x: 104, y: 88, w: 1366, h: 768 },
      children: [
        {
          name: 'MainMenu',
          type: 'MenuBar',
          automation_id: 'MainMenuStrip',
          class_name: 'MenuStrip',
          bounds: { x: 112, y: 120, w: 1350, h: 28 },
          children: [],
        },
        {
          name: 'Inventory Grid',
          type: 'DataGrid',
          automation_id: 'InventoryGrid',
          class_name: 'DataGridView',
          bounds: { x: 128, y: 176, w: 1318, h: 500 },
          children: [],
        },
        {
          name: 'Warehouse Status',
          type: 'StatusBar',
          automation_id: 'MainStatusBar',
          class_name: 'StatusStrip',
          bounds: { x: 112, y: 692, w: 1350, h: 28 },
          children: [],
        },
      ],
    },
  ],
  measurements: {
    window_size: { w: 1366, h: 768 },
    element_summary: [
      {
        name: 'MainMenu',
        type: 'MenuBar',
        bounds: { x: 112, y: 120, w: 1350, h: 28 },
      },
      {
        name: 'Inventory Grid',
        type: 'DataGrid',
        bounds: { x: 128, y: 176, w: 1318, h: 500 },
      },
    ],
    spacing: [
      {
        from: 'MainMenuStrip',
        to: 'InventoryGrid',
        axis: 'vertical',
        distance: 28,
      },
    ],
  },
  textContent: {
    buttons: ['Sync Inventory', 'Dispatch Picks'],
    labels: ['Warehouse A', 'Pending replenishments: 12'],
    inputs: [],
    lists: [
      {
        name: 'Inventory Grid',
        item_count: 24,
      },
    ],
  },
  annotationIndex: [
    {
      index: 1,
      label: 'Inventory Grid',
      bounds: { x: 128, y: 176, w: 1318, h: 500 },
    },
    {
      index: 2,
      label: 'Warehouse Status',
      bounds: { x: 112, y: 692, w: 1350, h: 28 },
    },
  ],
  extras: {
    component_model: {
      root_component: {
        type: 'Form',
        name: 'MainForm',
        title: 'Inventory Tracker - Warehouse A',
        children: [
          {
            type: 'MenuStrip',
            name: 'MainMenuStrip',
            items: ['File', 'Inventory', 'Transfers', 'Reports'],
          },
          {
            type: 'DataGridView',
            name: 'InventoryGrid',
            data_source: 'WarehouseInventoryBindingSource',
            columns: ['Sku', 'Description', 'OnHand', 'Allocated', 'Location'],
          },
          {
            type: 'StatusStrip',
            name: 'MainStatusBar',
            items: ['Ready', 'Warehouse A', 'Last Sync 09:14'],
          },
        ],
      },
    },
    performance_counters: {
      cpu_percent: 1.2,
      memory_bytes: 68_157_440,
      handle_count: 204,
      thread_count: 8,
      uptime_seconds: 7200,
    },
  },
});

const QT_FIXTURE = buildFixture({
  appType: 'qt',
  hwnd: 967248,
  locator: {
    type: 'title',
    value: 'Signal Monitor - Live Feed',
  },
  title: 'Signal Monitor - Live Feed',
  processName: 'SignalMonitor.exe',
  captureData: {
    provider: 'desktop-duplication',
    host: FIXED_HOST,
    process_name: 'SignalMonitor.exe',
    window_title: 'Signal Monitor - Live Feed',
    image_base64: encodeBase64('qt-window-capture'),
    pixel_format: 'bgra8',
    width: 1440,
    height: 810,
    scale_factor: 1,
    window_bounds: { x: 148, y: 72, w: 1440, h: 810 },
    client_bounds: { x: 156, y: 104, w: 1424, h: 754 },
    focused_element: 'SignalTable',
  },
  metadata: {
    host: FIXED_HOST,
    process_name: 'SignalMonitor.exe',
    window_title: 'Signal Monitor - Live Feed',
    framework: 'Qt',
    main_class_name: 'Qt5152QWindowIcon',
    executable_path: 'C:/Program Files/SignalMonitor/SignalMonitor.exe',
    automation_framework: 'UIAutomation',
    dpi_awareness: 'per_monitor_v2',
  },
  elementsTree: [
    {
      name: 'Signal Monitor - Live Feed',
      type: 'Window',
      automation_id: 'SignalMonitorWindow',
      class_name: 'Qt5152QWindowIcon',
      bounds: { x: 148, y: 72, w: 1440, h: 810 },
      children: [
        {
          name: 'Main Toolbar',
          type: 'ToolBar',
          automation_id: 'MainToolBar',
          class_name: 'QToolBar',
          bounds: { x: 172, y: 112, w: 1392, h: 40 },
          children: [],
        },
        {
          name: 'Signal Table',
          type: 'Table',
          automation_id: 'SignalTable',
          class_name: 'QTableView',
          bounds: { x: 172, y: 176, w: 1392, h: 544 },
          children: [],
        },
        {
          name: 'Acknowledge Alarm',
          type: 'Button',
          automation_id: 'AcknowledgeButton',
          class_name: 'QPushButton',
          bounds: { x: 1384, y: 736, w: 180, h: 36 },
          children: [],
        },
      ],
    },
  ],
  measurements: {
    window_size: { w: 1440, h: 810 },
    element_summary: [
      {
        name: 'Main Toolbar',
        type: 'ToolBar',
        bounds: { x: 172, y: 112, w: 1392, h: 40 },
      },
      {
        name: 'Signal Table',
        type: 'Table',
        bounds: { x: 172, y: 176, w: 1392, h: 544 },
      },
    ],
    spacing: [
      {
        from: 'MainToolBar',
        to: 'SignalTable',
        axis: 'vertical',
        distance: 24,
      },
    ],
  },
  textContent: {
    buttons: ['Acknowledge Alarm', 'Pause Feed'],
    labels: ['Signal Monitor', 'Live Feed'],
    inputs: [
      {
        label: 'Filter',
        value: 'priority:high',
      },
    ],
    lists: [
      {
        name: 'Signal Table',
        item_count: 18,
      },
    ],
  },
  annotationIndex: [
    {
      index: 1,
      label: 'Signal Table',
      bounds: { x: 172, y: 176, w: 1392, h: 544 },
    },
    {
      index: 2,
      label: 'Acknowledge Alarm',
      bounds: { x: 1384, y: 736, w: 180, h: 36 },
    },
  ],
  extras: {
    qt_object_tree: {
      root: {
        class_name: 'QMainWindow',
        object_name: 'SignalMonitorWindow',
        children: [
          {
            class_name: 'QToolBar',
            object_name: 'MainToolBar',
            actions: ['connectFeedAction', 'pauseFeedAction', 'exportAction'],
          },
          {
            class_name: 'QTableView',
            object_name: 'SignalTable',
            model: 'LiveFeedTableModel',
          },
          {
            class_name: 'QPushButton',
            object_name: 'AcknowledgeButton',
            text: 'Acknowledge Alarm',
          },
        ],
      },
    },
    performance_counters: {
      cpu_percent: 3.7,
      memory_bytes: 145_752_064,
      handle_count: 278,
      thread_count: 14,
      uptime_seconds: 2890,
    },
  },
});

const FIXTURE_CATALOG = deepFreeze({
  wpf: WPF_FIXTURE,
  win32: WIN32_FIXTURE,
  electron: ELECTRON_FIXTURE,
  winforms: WINFORMS_FIXTURE,
  qt: QT_FIXTURE,
});

module.exports = {
  encodeBase64,
  createImageBlob,
  countTreeNodes,
  deepFreeze,
  buildFixture,
  WPF_FIXTURE,
  WIN32_FIXTURE,
  ELECTRON_FIXTURE,
  WINFORMS_FIXTURE,
  QT_FIXTURE,
  FIXTURE_CATALOG,
};
