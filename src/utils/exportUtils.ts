/**
 * Universal CSV & JSON Exporter Utility
 * Cleanly exports Lead, Investor, and Partner datasets for CRM sync
 * (HubSpot, Salesforce, Apollo, Instantly, Clay, Google Sheets).
 */

export function exportToCSV<T extends Record<string, any>>(
  data: T[],
  filename: string,
  columnMapping?: { [key: string]: string }
) {
  if (!data || data.length === 0) {
    console.warn("No data available to export.");
    return;
  }

  // Determine headers
  const keys = Object.keys(data[0]);
  const headers = keys.map((key) => columnMapping?.[key] || key);

  const csvRows: string[] = [];
  csvRows.push(headers.map((h) => `"${String(h).replace(/"/g, '""')}"`).join(","));

  for (const row of data) {
    const values = keys.map((key) => {
      let val = row[key];
      if (val === null || val === undefined) {
        return '""';
      }
      if (typeof val === "object") {
        if (Array.isArray(val)) {
          val = val.join("; ");
        } else if (val.totalScore !== undefined) {
          val = `${val.totalScore}/100`;
        } else {
          val = JSON.stringify(val);
        }
      }
      const stringVal = String(val).replace(/"/g, '""');
      return `"${stringVal}"`;
    });
    csvRows.push(values.join(","));
  }

  const csvString = csvRows.join("\n");
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `${filename}_${new Date().toISOString().split("T")[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportToJSON<T>(data: T[], filename: string) {
  if (!data || data.length === 0) return;
  const jsonString = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonString], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `${filename}_${new Date().toISOString().split("T")[0]}.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
