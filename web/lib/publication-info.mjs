const repository = "https://github.com/uist1idrju3i/gogo-fpga";

export function publicationView(info) {
  if (!info || typeof info.sha !== "string" || info.sha.length !== 40 ||
      !/^[0-9a-f]{40}$/.test(info.sha) || info.short_sha !== info.sha.slice(0, 7) ||
      typeof info.commit_date !== "string" || typeof info.run_url !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(info.commit_date) ||
      !Number.isFinite(Date.parse(info.commit_date)) ||
      new Date(info.commit_date).toISOString().replace(".000Z", "Z") !== info.commit_date ||
      !new RegExp(`^${repository.replaceAll(".", "\\.")}/actions/runs/[1-9][0-9]{0,19}$`).test(info.run_url)) {
    return { label: "開発版" };
  }
  return {
    label: `公開版 ${info.short_sha}`,
    href: `${repository}/commit/${info.sha}`,
    title: `元コミット: ${info.sha}\nコミット日時: ${info.commit_date}\nビルド: ${info.run_url}`,
  };
}

export async function loadPublicationInfo(fetcher = globalThis.fetch) {
  try {
    const response = await fetcher(new URL("../build-info.json", import.meta.url), {
      mode: "same-origin", credentials: "omit", redirect: "error", cache: "no-cache",
      signal: AbortSignal.timeout(5000),
    });
    return publicationView(response.ok ? await response.json() : null);
  } catch {
    return publicationView(null);
  }
}

export async function initializePublicationInfo(element) {
  const view = await loadPublicationInfo();
  if (!view.href) return;
  const link = element.ownerDocument.createElement("a");
  link.textContent = view.label;
  link.href = view.href;
  link.title = view.title;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  element.replaceChildren(link);
}
