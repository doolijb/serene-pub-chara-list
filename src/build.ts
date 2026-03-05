import fs from "fs"
import path from "path"
import yaml from "js-yaml"
import extractChunks from "png-chunks-extract"
import textChunk from "png-chunk-text"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields extracted from a Character Card V2 `data` object (or V1 root). */
interface CardData {
  name?: string
  description?: string
  personality?: string
  creator?: string
  creator_notes?: string
  character_version?: string
  tags?: string[]
  create_date?: string
  created?: string
  extensions?: {
    nickname?: string
    create_date?: string
    date?: string
    ginger?: {
      data?: {
        creation_date?: string
        [key: string]: unknown
      }
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** Full Character Card V2 envelope, or a legacy V1 card (fields at root). */
interface CharaCard {
  spec?: string
  spec_version?: string
  data?: CardData
  // V1 / fallback fields at root level
  name?: string
  description?: string
  creator?: string
  character_version?: string
  tags?: string[]
  [key: string]: unknown
}

interface CharacterEntry {
  name: string
  nickname: string | null
  description: string | null
  personality: string | null
  author: string | null
  author_notes: string | null
  date: string | null
  version: string | null
  tags: string[]
  file: string
  category: string | null
}

interface PersonaEntry {
  name: string
  description: string | null
  author: string | null
  author_notes: string | null
  date: string | null
  version: string | null
  tags: string[]
  file: string
  category: string | null
}

// ---------------------------------------------------------------------------
// PNG / JSON parsing helpers
// ---------------------------------------------------------------------------

/**
 * Reads a character-card PNG and returns the decoded JSON object from the
 * `tEXt[chara]` chunk (base-64 encoded).  Returns null if absent or invalid.
 */
function readPngCard(filePath: string): CharaCard | null {
  let buffer: Buffer
  try {
    buffer = fs.readFileSync(filePath)
  } catch (err) {
    console.warn(`Warning: could not read file ${filePath}:`, err)
    return null
  }

  let chunks: Array<{ name: string; data: Buffer }>
  try {
    chunks = extractChunks(buffer) as Array<{ name: string; data: Buffer }>
  } catch (err) {
    console.warn(`Warning: could not parse PNG chunks in ${filePath}:`, err)
    return null
  }

  for (const chunk of chunks) {
    if (chunk.name !== "tEXt") continue
    let decoded: { keyword: string; text: string }
    try {
      decoded = textChunk.decode(chunk.data)
    } catch {
      continue
    }
    if (decoded.keyword !== "chara" && decoded.keyword !== "ccv3") continue
    try {
      const json = Buffer.from(decoded.text, "base64").toString("utf-8")
      return JSON.parse(json) as CharaCard
    } catch (err) {
      console.warn(`Warning: invalid chara JSON in ${filePath}:`, err)
      return null
    }
  }

  return null
}

/** Reads a `.json` character-card file and returns the parsed object. */
function readJsonCard(filePath: string): CharaCard | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    return JSON.parse(content) as CharaCard
  } catch (err) {
    console.warn(`Warning: could not parse JSON card ${filePath}:`, err)
    return null
  }
}

/**
 * Normalises a raw card object (V1 or V2) into a flat set of fields.
 * V2 cards nest their data under a `data` key; V1 cards put fields at root.
 */
function normaliseCard(raw: CharaCard): {
  name: string
  nickname: string | null
  description: string | null
  personality: string | null
  author: string | null
  author_notes: string | null
  date: string | null
  version: string | null
  tags: string[]
} {
  const d: CardData = raw.data ?? (raw as CardData)

  const name = (d.name ?? "Unknown").trim()
  const description = typeof d.description === "string" && d.description.trim()
    ? d.description.trim()
    : null
  const personality = typeof d.personality === "string" && d.personality.trim()
    ? d.personality.trim()
    : null
  const author = typeof d.creator === "string" && d.creator.trim()
    ? d.creator.trim()
    : null
  const author_notes = typeof d.creator_notes === "string" && d.creator_notes.trim()
    ? d.creator_notes.trim()
    : null
  const version = typeof d.character_version === "string" && d.character_version.trim()
    ? d.character_version.trim()
    : null
  const tags: string[] = Array.isArray(d.tags)
    ? d.tags.filter((t): t is string => typeof t === "string")
    : []
  const nickname =
    typeof d.extensions?.nickname === "string" && d.extensions.nickname.trim()
      ? d.extensions.nickname.trim()
      : null

  // Date: check common locations in card data
  const rawDate =
    (typeof d.create_date === "string" ? d.create_date : null) ??
    (typeof d.created === "string" ? d.created : null) ??
    (typeof d.extensions?.create_date === "string" ? d.extensions.create_date : null) ??
    (typeof d.extensions?.date === "string" ? d.extensions.date : null) ??
    (typeof d.extensions?.ginger?.data?.creation_date === "string" ? d.extensions.ginger.data.creation_date : null) ??
    null
  const date = rawDate?.trim() || null

  return { name, nickname, description, personality, author, author_notes, date, version, tags }
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

type CardType = "characters" | "personas"

/**
 * Processes a single file and returns a CharacterEntry / PersonaEntry, or
 * null if the file is not a supported card file or has no metadata.
 */
function processFile(
  absolutePath: string,
  relativeFile: string,
  category: string | null,
  type: CardType
): CharacterEntry | PersonaEntry | null {
  const ext = path.extname(absolutePath).toLowerCase()

  let raw: CharaCard | null = null
  if (ext === ".png") {
    raw = readPngCard(absolutePath)
  } else if (ext === ".json") {
    raw = readJsonCard(absolutePath)
  } else {
    return null // unsupported extension
  }

  if (!raw) return null

  const { name, nickname, description, personality, author, author_notes, date, version, tags } = normaliseCard(raw)

  if (type === "characters") {
    return { name, nickname, description, personality, author, author_notes, date, version, tags, file: relativeFile, category }
  }
  return { name, description, author, author_notes, date, version, tags, file: relativeFile, category }
}

/**
 * Scans a top-level directory for card files.
 *
 * Layout rules (no deeper than one sub-directory):
 *   <dir>/Card.png          → category: null
 *   <dir>/Fantasy/Card.png  → category: "Fantasy"
 */
function scanDirectory(
  dir: string,
  type: CardType
): Array<CharacterEntry | PersonaEntry> {
  if (!fs.existsSync(dir)) {
    console.warn(`Warning: directory ${dir} does not exist, skipping.`)
    return []
  }

  const entries: Array<CharacterEntry | PersonaEntry> = []

  for (const item of fs.readdirSync(dir)) {
    if (item.startsWith(".")) continue
    const itemPath = path.join(dir, item)
    const stat = fs.statSync(itemPath)

    if (stat.isDirectory()) {
      // One level of category sub-directories only
      for (const file of fs.readdirSync(itemPath)) {
        if (file.startsWith(".")) continue
        const filePath = path.join(itemPath, file)
        if (!fs.statSync(filePath).isFile()) continue
        const entry = processFile(filePath, `${type}/${item}/${file}`, item, type)
        if (entry) entries.push(entry)
      }
    } else if (stat.isFile()) {
      const entry = processFile(itemPath, `${type}/${item}`, null, type)
      if (entry) entries.push(entry)
    }
  }

  return entries
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function build(): void {
  const root = process.cwd()

  // Characters
  console.log("Building characters.yaml…")
  const characters = (scanDirectory(path.join(root, "characters"), "characters") as CharacterEntry[])
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))

  fs.writeFileSync(
    path.join(root, "characters.yaml"),
    yaml.dump({ characters }, { indent: 2, lineWidth: -1, noRefs: true, quotingType: '"' })
  )
  console.log(`  → ${characters.length} character(s) written to characters.yaml`)

  // Personas
  console.log("Building personas.yaml…")
  const personas = (scanDirectory(path.join(root, "personas"), "personas") as PersonaEntry[])
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))

  fs.writeFileSync(
    path.join(root, "personas.yaml"),
    yaml.dump({ personas }, { indent: 2, lineWidth: -1, noRefs: true, quotingType: '"' })
  )
  console.log(`  → ${personas.length} persona(s) written to personas.yaml`)
}

build()
