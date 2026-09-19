"use client";

import { useEffect, useMemo, useState } from "react";
import { BookOpenCheck, Languages, Printer, Search } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { MANUAL_GROUPS, USER_MANUAL_TOPICS, type ManualLanguage } from "@/lib/user-manual";

const groupOrder = ["START", "SALES", "STOCK", "FINANCE", "ADMIN"] as const;

export function HelpCenter() {
  const [language, setLanguage] = useState<ManualLanguage>("zh");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const saved = window.localStorage.getItem("konkon-manual-language");
    if (saved === "zh" || saved === "en") setLanguage(saved);
  }, []);

  function chooseLanguage(value: ManualLanguage) {
    setLanguage(value);
    window.localStorage.setItem("konkon-manual-language", value);
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return USER_MANUAL_TOPICS;
    return USER_MANUAL_TOPICS.filter((topic) => {
      const copy = topic[language];
      return [copy.title, copy.summary, ...copy.steps, ...copy.tips, ...topic.roles].join(" ").toLocaleLowerCase().includes(needle);
    });
  }, [language, query]);

  const text = language === "zh" ? {
    eyebrow: "学习中心",
    title: "Kōn-Kōn Ledger 中文使用手册",
    description: "从首次设置到日常营运、会计控制与月结的完整教学。搜索功能名称或工作步骤即可快速定位。",
    search: "搜索功能、步骤或角色…",
    contents: "手册目录",
    results: `${filtered.length} 个主题`,
    roles: "适用角色",
    steps: "操作步骤",
    tips: "重点提醒",
    empty: "没有找到相符内容，请尝试较短的关键词。",
    updated: "线上手册 · 与当前功能同步",
  } : {
    eyebrow: "LEARNING CENTRE",
    title: "Kōn-Kōn Ledger user manual",
    description: "A complete guide from first setup through daily operations, accounting control and month-end close. Search any feature, task or role.",
    search: "Search features, tasks or roles…",
    contents: "Manual contents",
    results: `${filtered.length} topics`,
    roles: "For",
    steps: "How to use it",
    tips: "Important notes",
    empty: "No matching topic. Try a shorter search term.",
    updated: "Online manual · aligned with the current product",
  };

  return (
    <div className="page page-enter help-page">
      <PageHeader
        eyebrow={text.eyebrow}
        title={text.title}
        description={text.description}
        action={<div className="help-actions no-print">
          <div className="language-switch" aria-label="Manual language">
            <button className={language === "zh" ? "active" : ""} onClick={() => chooseLanguage("zh")}><Languages size={15} />中文</button>
            <button className={language === "en" ? "active" : ""} onClick={() => chooseLanguage("en")}><Languages size={15} />English</button>
          </div>
          <button className="button button-secondary" onClick={() => window.print()}><Printer size={15} />{language === "zh" ? "打印 / 存为 PDF" : "Print / save PDF"}</button>
        </div>}
      />

      <section className="help-toolbar no-print">
        <label><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.search} /></label>
        <span>{text.results}</span>
      </section>

      <div className="help-layout">
        <aside className="help-toc no-print">
          <header><BookOpenCheck size={18} /><strong>{text.contents}</strong></header>
          {groupOrder.map((group) => {
            const topics = filtered.filter((topic) => topic.group === group);
            if (!topics.length) return null;
            return <section key={group}>
              <span>{MANUAL_GROUPS[language][group]}</span>
              {topics.map((topic) => <a key={topic.id} href={`#manual-${topic.id}`}>{topic[language].title}</a>)}
            </section>;
          })}
        </aside>

        <main className="help-content">
          {filtered.length ? groupOrder.map((group) => {
            const topics = filtered.filter((topic) => topic.group === group);
            if (!topics.length) return null;
            return <section className="manual-group" key={group}>
              <header><span>{MANUAL_GROUPS[language][group]}</span><i /></header>
              {topics.map((topic, index) => {
                const copy = topic[language];
                return <article id={`manual-${topic.id}`} key={topic.id}>
                  <div className="manual-number">{String(index + 1).padStart(2, "0")}</div>
                  <div>
                    <h2>{copy.title}</h2>
                    <p className="manual-summary">{copy.summary}</p>
                    <p className="manual-roles"><strong>{text.roles}</strong> · {topic.roles.join(" · ")}</p>
                    <h3>{text.steps}</h3>
                    <ol>{copy.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                    <div className="manual-tips"><strong>{text.tips}</strong><ul>{copy.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul></div>
                  </div>
                </article>;
              })}
            </section>;
          }) : <section className="panel help-empty"><Search /><p>{text.empty}</p></section>}
          <footer className="manual-footer"><span>{text.updated}</span><span>© Kōn-Kōn Matchā Ledger</span></footer>
        </main>
      </div>
    </div>
  );
}
