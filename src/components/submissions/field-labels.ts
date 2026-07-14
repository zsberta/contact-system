// Field label mapping — shared between SubmissionDetailModal and
// SubmissionsCalendarTab. Mirrors lib/email-templates.js KNOWN_FIELDS.

function normaliseKey(key: string): string {
  return key
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const KNOWN_FIELDS: Record<
  string,
  { hu: string; en: string; aliases: string[] }
> = {
  name: {
    hu: "N\u00e9v",
    en: "Name",
    aliases: ["name", "fullname", "yourname", "vezeteknev", "keresztnev"],
  },
  firstName: {
    hu: "Keresztn\u00e9v",
    en: "First name",
    aliases: ["firstname", "givenname", "keresztnev", "fname"],
  },
  lastName: {
    hu: "Vezet\u00e9kn\u00e9v",
    en: "Last name",
    aliases: ["lastname", "surname", "familyname", "vezeteknev", "lname"],
  },
  email: {
    hu: "E-mail",
    en: "Email",
    aliases: ["email", "mail", "emailaddress", "epost", "emailcim"],
  },
  phone: {
    hu: "Telefon",
    en: "Phone",
    aliases: [
      "phone",
      "tel",
      "telefon",
      "mobil",
      "mobilphone",
      "phonenumber",
      "telefonszam",
    ],
  },
  message: {
    hu: "\u00dczenet",
    en: "Message",
    aliases: [
      "message",
      "msg",
      "uzenet",
      "uzenetszoveg",
      "megjegyzes",
    ],
  },
  subject: {
    hu: "T\u00e1rgy",
    en: "Subject",
    aliases: ["subject", "targy"],
  },
  company: {
    hu: "C\u00e9g",
    en: "Company",
    aliases: [
      "company",
      "ceg",
      "companyname",
      "organization",
      "organisation",
      "cegnev",
    ],
  },
  consent: {
    hu: "Adatkezel\u00e9si hozz\u00e1j\u00e1rul\u00e1s",
    en: "Consent",
    aliases: [
      "consent",
      "hozzajarulas",
      "adatvedelmi",
      "gdpr",
      "privacy",
      "adatkezeles",
      "adatkezelesi",
      "hozzajarulok",
    ],
  },
  players: {
    hu: "J\u00e1t\u00e9kosok sz\u00e1ma",
    en: "Players",
    aliases: [
      "players",
      "playercount",
      "jatekosok",
      "jatekosokszama",
      "numberofplayers",
      "noshow",
      "participantcount",
      "participants",
    ],
  },
  address: {
    hu: "C\u00edm",
    en: "Address",
    aliases: ["address", "cim", "location"],
  },
  date: {
    hu: "D\u00e1tum",
    en: "Date",
    aliases: ["date", "datum", "datums"],
  },
  time: {
    hu: "Id\u0151pont",
    en: "Time",
    aliases: ["time", "idotartam", "ido"],
  },
  guests: {
    hu: "Vend\u00e9gek sz\u00e1ma",
    en: "Guests",
    aliases: ["guests", "guestcount", "vendegszam", "numberofguests"],
  },
  note: {
    hu: "Megjegyz\u00e9s",
    en: "Note",
    aliases: ["note", "notes", "comment"],
  },
};

export function labelFor(rawKey: string, locale: string): string {
  const norm = normaliseKey(rawKey);
  for (const field of Object.values(KNOWN_FIELDS)) {
    if (field.aliases.includes(norm)) return field[locale] || field.en;
  }
  return rawKey.charAt(0).toUpperCase() + rawKey.slice(1);
}

export function formatValue(
  value: unknown,
  locale: string,
): string {
  if (value === null || value === undefined) return "\u2014";
  if (typeof value === "boolean")
    return value
      ? locale === "hu"
        ? "Igen"
        : "Yes"
      : locale === "hu"
        ? "Nem"
        : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
