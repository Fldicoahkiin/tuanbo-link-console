import type { ReactNode } from 'react';
import type { SettingsScope } from './settings-navigation';
import './settings-page.css';

const scopeText: Record<SettingsScope, string> = { machine: '本机设置', project: '工程设置', guide: '使用说明', help: '帮助' };
const scopeHelp: Record<SettingsScope, string> = {
  machine: '保存在这台电脑上，打开哪个工程都一样',
  project: '保存在工程文件里，换电脑打开这个工程也一样；改完记得保存工程',
  guide: '只是说明，没有要设置的',
  help: '查看记录、联系售后'
};

/** Where a group of settings is saved, next to its title, so this computer's and the project's settings are never confused. */
export function ScopeTag({ scope }: { scope: SettingsScope }): JSX.Element {
  return <span className="settings-scope-tag" data-scope={scope} title={scopeHelp[scope]}>{scopeText[scope]}</span>;
}

/**
 * One settings page (2026-10-30 rework: every page has this one frame). The title says what the page is
 * for, the tag where its settings are saved; `notices` are page-wide states such as "locked while
 * playing". The content is a stack of cards (link/ui Card).
 */
export function SettingsPage({ id, title, description, scope, hidden, notices, children }: {
  id: string;
  title: string;
  description: string;
  scope: SettingsScope;
  hidden: boolean;
  notices?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return <section hidden={hidden} data-settings-section={id} className="settings-page" data-density="comfortable" aria-label={`${title}设置`}>
    <header className="settings-page-heading">
      <div><h1>{title}</h1><p>{description}</p></div>
      <ScopeTag scope={scope} />
    </header>
    {notices ? <div className="settings-page-notices">{notices}</div> : null}
    <div className="settings-page-body">{children}</div>
  </section>;
}
