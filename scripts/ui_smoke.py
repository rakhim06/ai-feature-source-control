from playwright.sync_api import sync_playwright
from pathlib import Path
import json
import os
import tempfile

root = Path(__file__).resolve().parents[1]
preview = Path(os.getenv('AI_FEATURE_UI_PREVIEW', str(Path(tempfile.gettempdir()) / 'aifg-ui-preview.png')))

def section(phase, label, groups):
    return {'phase': phase, 'label': label, 'count': sum(len(g['files']) for g in groups), 'groups': groups}

def group(label, *names):
    files = [{'name': name.split('/')[-1], 'path': name, 'directory': 'src', 'status': 'M', 'conflicted':False} for name in names]
    # Represent AI classification from a single pass, with file-level detail.
    components = {}
    for file in files:
        if 'test' in file['name']:
            component, task = 'Export API', 'Test request validation'
        elif 'export' in file['name']:
            component, task = 'Export API', 'Create asynchronous export'
        else:
            component, task = 'Request validation', 'Validate season range'
        entry = components.setdefault(component, {'name': component, 'count': 0, 'files': [], 'tasks': {}})
        entry['files'].append(file)
        entry['count'] += 1
        task_entry = entry['tasks'].setdefault(task, {'name': task, 'count': 0, 'files': []})
        task_entry['files'].append(file)
        task_entry['count'] += 1
    return {'name': label, 'count': len(names), 'files': files,
        'components': [{**c, 'tasks': list(c['tasks'].values())} for c in components.values()]}


repos = [
 {
  'root':'/Users/dev/HyWater/hywater-portal-frontend','name':'hywater-portal-frontend','branch':'SE-2385-export-all-fields',
  'hasCommit':True,'primaryAction':'commit','message':'feat: Export selected fields', 'dirty':2,'staged':2,
  'ahead':0,'behind':4,'upstream':'origin/SE-2385-export-all-fields',
  'syncing':False,'fetching':False,'pushing':False,'publishing':False,'committing':False,'generating':False,'switching':False,
  'sections':[section('index','Staged Changes',[group('feat: Export all fields','src/api/export.ts','src/api/export.test.ts')]), section('work','Changes',[])],
 },
 {
  'root':'/Users/dev/HyWater/hywater-portal-backend','name':'hywater-portal-backend','branch':'fix/session-validation',
  'hasCommit':True,'primaryAction':'push','message':'','dirty':1,'staged':0,
  'ahead':2,'behind':0,'upstream':'origin/fix/session-validation',
  'syncing':False,'fetching':False,'pushing':False,'publishing':False,'committing':False,'generating':False,'switching':False,
  'sections':[section('index','Staged Changes',[]), section('work','Changes',[group('fix: Season validation','src/api/seasons.ts')])],
 },
 {
  'root':'/Users/dev/HyWater/hywater-portal-infra','name':'hywater-portal-infra','branch':'feature/new-setup',
  'hasCommit':True,'primaryAction':'publish','message':'','dirty':0,'staged':0,
  'ahead':None,'behind':None,'upstream':None,
  'syncing':False,'fetching':False,'pushing':False,'publishing':False,'committing':False,'generating':False,'switching':False,
  'sections':[section('index','Staged Changes',[]),section('work','Changes',[])],
 }
]

with sync_playwright() as p:
    browser=p.chromium.launch(
        headless=True,
        executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None),
        args=['--no-sandbox']
    )
    page=browser.new_page(viewport={'width':460,'height':850},device_scale_factor=1)
    errors=[]
    page.on('pageerror',lambda err: errors.append(str(err)))
    page.set_content('''<!doctype html><html><head><style>
      :root{--vscode-foreground:#d4d4d4;--vscode-sideBar-background:#181818;--vscode-descriptionForeground:#999;
      --vscode-sideBarSectionHeader-background:#242424;--vscode-button-background:#006cbe;--vscode-button-foreground:#fff;
      --vscode-button-hoverBackground:#0e639c;--vscode-input-background:#313131;--vscode-input-foreground:#ddd;
      --vscode-icon-foreground:#bbb;--vscode-list-hoverBackground:#333;--vscode-input-placeholderForeground:#777;
      --vscode-editor-foreground:#ddd;--vscode-gitDecoration-modifiedResourceForeground:#d9a769;
      --vscode-gitDecoration-addedResourceForeground:#4fb782;--vscode-focusBorder:#0e639c;
      --vscode-font-family:-apple-system,BlinkMacSystemFont, sans-serif;--vscode-font-size:13px}
    </style></head><body><div id="app">
    <p id="status" role="status" aria-live="polite"></p>
    <div id="repositories" aria-label="Git repositories and changes"></div>
    <div id="context-menu" class="context-menu" role="menu" hidden></div>
    </div></body></html>''')
    page.evaluate('''window.sent=[]; window.stored={}; window.acquireVsCodeApi = () => ({
        postMessage: message=> {window.sent.push(message);},
        getState: ()=>window.stored, setState: state=>{window.stored=state;}
    });''')
    page.add_style_tag(path=str(root/'media/webview.css'))
    page.add_script_tag(path=str(root/'media/webview.js'))
    assert page.evaluate('window.sent[0].type')=='ready'
    page.evaluate('(model)=> {window.currentModel=model; window.postMessage({type:"update",version:1,model},"*")}',{'repositories':repos,'aiProvider':'codex','classifying':False,'detailLevel':3,'classifyingRoot':None})
    page.wait_for_timeout(220)
    cards=page.locator('section.repository')
    assert cards.count()==3,cards.count()
    a=cards.nth(0)
    b=cards.nth(1)
    c=cards.nth(2)
    assert a.locator('.section-row').count()==1, a.locator('.section-row').all_text_contents()
    assert 'Staged Changes' in a.locator('.section-row').inner_text(),repr(a.locator('.section-row').inner_text())
    assert b.locator('.section-row').count()==1, b.locator('.section-row').all_text_contents()
    assert 'Changes' in b.locator('.section-row').inner_text(),repr(b.locator('.section-row').inner_text())
    assert a.locator('button.sync-action .sync-counts span').all_text_contents()==['4 ↓','0 ↑']
    assert b.locator('button.sync-action .sync-counts span').all_text_contents()==['0 ↓','2 ↑']
    assert c.locator('button.sync-action').get_attribute('disabled') is not None
    assert c.locator('.repository-body').is_visible() # Publish stays visible even without staged files.
    assert c.locator('.section-row').count()==0
    assert a.locator('button.generate-message svg path').count()==2
    for elt in page.locator('button.action').all():
        title=elt.get_attribute('title')
        assert title and len(title.split())==1,(elt.get_attribute('class'),title)
    for elt in page.locator('button.branch-button, button.repo-toggle, button.primary').all():
        title=elt.get_attribute('title')
        assert title and len(title.split())==1,(elt.get_attribute('class'),title)
    assert a.locator('button.generate-message').get_attribute('aria-label')=='Generate commit message with Codex from staged changes'
    a.locator('button.generate-message').click()
    assert page.evaluate('window.sent.at(-1).type')=='generateMessage'
    # Detail is exclusively a VS Code setting pushed through the ViewModel.
    # No in-Webview 1/2/3 toolbar or client-side LLM request exists.
    assert page.locator('.detail-toolbar').count() == 0
    before_level_messages = page.evaluate('window.sent.length')
    assert a.locator('.task-row').count() >= 2
    assert a.locator('.file-row.depth-3').count() == 2
    page.screenshot(path=str(preview),full_page=True)
    for version, level in [(2,2),(3,1),(4,3)]:
        page.evaluate('({version,level})=> window.postMessage({type:"update",version,model:{...window.currentModel,detailLevel:level}},"*")', {'version':version,'level':level})
        page.wait_for_timeout(30)
        # The host, not the Webview, updates the setting; no response is sent to AI.
    assert page.evaluate('window.sent.length') == before_level_messages
    # The hierarchy disclosure is a larger 22px chevron button, not a tiny glyph.
    chevron = a.locator('.feature-row .tree-chevron').first
    assert chevron.inner_text() in ['▾', '▸']
    before_count = a.locator('.file-row').count()
    chevron.click()
    assert a.locator('.file-row').count() < before_count
    a.locator('.feature-row .tree-chevron').first.click()
    assert a.locator('.file-row').count() == before_count
    assert a.locator('.tree-chevron').first.evaluate('(el)=>el.getBoundingClientRect().width') >= 22
    # Per-repository AI action: no global multi-repo submission is triggered.
    b.locator('.classify-action').click()
    assert page.evaluate('window.sent.at(-1).type') == 'classify'
    assert page.evaluate('window.sent.at(-1).root') == repos[1]['root']
    # Ensure switching to a second update hides empty groups without reload.
    changed = json.loads(json.dumps(repos))
    changed[0]['sections'][0] = section('index','Staged Changes',[])
    changed[0]['sections'][1] = section('work','Changes',[group('fix: New changes','src/ui/new.ts')])
    page.evaluate('(model)=>window.postMessage({type:"update",version:5,model},"*")', {'repositories':changed,'aiProvider':'codex','classifying':False,'detailLevel':3,'classifyingRoot':None})
    page.wait_for_timeout(200)
    assert a.locator('.section-row').count()==1
    assert 'Changes' in a.locator('.section-row').inner_text(),repr(a.locator('.section-row').inner_text())
    assert not errors, errors
    print('Chromium integration checks passed: 3 repos; settings-only detail; chevron buttons; per-repo classify; empty sections; sync counts; tooltips; sparkles.')
    print('Preview:', preview)
    browser.close()
