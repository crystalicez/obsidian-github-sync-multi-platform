import { Notice, moment } from "obsidian";


/**
 * timestampToDate
 * Converts timestamp to formatted date string (YYYY-MM-DD HH:mm:ss)
 * @param timestamp - Timestamp in milliseconds
 * @returns Formatted date string
 */
export const timestampToDate = function (timestamp: number): string {
  return moment(timestamp).format("YYYY-MM-DD HH:mm:ss")
}

/**
 * stringToDate
 * Converts date string to formatted date string (YYYY-MM-DD HH:mm:ss)
 * If the input date string is empty, default date "1970-01-01 00:00:00" is used.
 * @param date - Date string
 * @returns Formatted date string
 */
export const stringToDate = function (date: string): string {
  if (!date || date == "") {
    date = "1970-01-01 00:00:00"
  }
  return moment(date).format("YYYY-MM-DD HH:mm:ss")
}

/**
 * hashContent
 * Uses a simple hash function to generate the hash value of the input string
 * @param content - String content to hash
 * @returns Hash value of the string content
 */
export const hashContent = function (content: string): string {
  // Uses a simple hash function to generate the hash value
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash &= hash
  }
  return String(hash)
}

/**
 * showErrorDialog
 * Displays an error dialog with the passed message
 * @param message - Error message to display
 */
export const showErrorDialog = function (message: string): void {
  new Notice(message)
}

/**
 * dump
 * Prints the passed message to the console
 * @param message - Message to print, can be multiple parameters
 */
export const dump = function (..._message: unknown[]): void {
  // intentionally empty in production
}




export function calculateWordCount(content: string): number {
  if (!content) return 0;
  // Remove frontmatter
  const cleanContent = content.replace(/^---[\s\S]*?---/, "");
  // Remove markdown tags (approximate)
  const noMarkdown = cleanContent
    .replace(/[#*`~[\]()!]/g, "")
    .replace(/\s+/g, "");
  return noMarkdown.length;
}

export function calculateCleanWords(content: string): number {
  return calculateWordCount(content);
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\/.+/i.test(url);
}

export function isWsUrl(url: string): boolean {
  return /^wss?:\/\/.+/i.test(url);
}