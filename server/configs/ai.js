import OpenAI from 'openai'
import { env } from './env.js'

/**
 * Google Gemini exposed through its OpenAI-compatible endpoint, so the
 * standard `openai` SDK can drive it. Swapping providers means changing
 * GEMINI_BASE_URL / GEMINI_MODEL, not the controllers.
 */
const DEFAULT_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/'

// Newer Gemini models spend part of the output budget on internal reasoning.
// This extra room keeps that from eating into the visible answer.
const THINKING_HEADROOM = 2000

// How many times to ask the model to carry on if it still hits the limit.
const MAX_CONTINUATIONS = 2

let client = null

export const aiClient = () => {
  if (!env.gemini.apiKey) {
    throw Object.assign(
      new Error(
        'Text generation is not configured on this server (GEMINI_API_KEY is missing).'
      ),
      { statusCode: 503, expose: true }
    )
  }
  client ??= new OpenAI({
    apiKey: env.gemini.apiKey,
    baseURL: env.gemini.baseUrl || DEFAULT_BASE_URL,
  })
  return client
}

/** Map a provider failure to a message the user can act on. */
const providerError = (error) => {
  const status = error?.status
  let message = 'The AI provider request failed.'
  let statusCode = 502

  if (status === 404) {
    message = 'The configured Gemini model was not found. Check GEMINI_MODEL.'
  } else if (status === 400 || status === 401 || status === 403) {
    message =
      'Gemini rejected the request. Check GEMINI_API_KEY, GEMINI_MODEL and the uploaded file.'
  } else if (status === 429) {
    message = 'Gemini rate limit reached. Please try again in a moment.'
    statusCode = 429
  }

  return Object.assign(new Error(message), { statusCode, expose: true })
}

/**
 * Shared completion call.
 * Returns { content, truncated } where `truncated` means the model stopped
 * because it hit the token limit, not because it finished.
 */
const complete = async (messages, maxTokens) => {
  let response
  try {
    response = await aiClient().chat.completions.create({
      model: env.gemini.model,
      messages,
      temperature: 0.7,
      max_tokens: maxTokens + THINKING_HEADROOM,
    })
  } catch (error) {
    if (error?.statusCode) throw error // already one of our own errors
    console.error('Gemini request failed:', error?.status, error?.message)
    throw providerError(error)
  }

  const choice = response.choices?.[0]
  const content = choice?.message?.content
  if (!content?.trim()) {
    throw Object.assign(
      new Error('The AI provider returned an empty response. Try again.'),
      { statusCode: 502, expose: true }
    )
  }
  return { content, truncated: choice.finish_reason === 'length' }
}

/**
 * Text-only completion. If the model gets cut off by the token limit, it is
 * asked to continue from where it stopped, so answers never end mid-sentence.
 */
export const generateText = async (prompt, { maxTokens = 1200 } = {}) => {
  const messages = [{ role: 'user', content: prompt }]
  let { content: full, truncated } = await complete(messages, maxTokens)

  for (let i = 0; truncated && i < MAX_CONTINUATIONS; i += 1) {
    const next = await complete(
      [
        ...messages,
        { role: 'assistant', content: full },
        {
          role: 'user',
          content:
            'Continue exactly from where you stopped. Do not repeat anything ' +
            'and do not add a preamble. Finish the piece with a proper conclusion.',
        },
      ],
      maxTokens
    )
    full += next.content
    truncated = next.truncated
  }

  return full.trim()
}

/**
 * Completion that includes one image (base64, no data-URL prefix).
 * Used to read resumes uploaded as JPG or PNG.
 */
export const generateTextFromImage = async (
  prompt,
  { base64, mimeType = 'image/jpeg', maxTokens = 2000 }
) => {
  const { content } = await complete(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
    maxTokens
  )
  return content.trim()
}