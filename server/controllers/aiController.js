import fs from 'node:fs/promises'
import axios from 'axios'
import FormData from 'form-data'
import pdf from 'pdf-parse/lib/pdf-parse.js'

import sql from '../configs/db.js'
import cloudinary from '../configs/cloudinary.js'
import { generateText, generateTextFromImage } from '../configs/ai.js'
import { env, cloudinaryConfigured } from '../configs/env.js'
import { consumeFreeUsage } from '../middlewares/auth.js'

/** Persist a creation and hand the saved row back to the caller. */
const saveCreation = async ({ userId, prompt, content, type, publish = false }) => {
  const [creation] = await sql`
    INSERT INTO creations (user_id, prompt, content, type, publish)
    VALUES (${userId}, ${prompt}, ${content}, ${type}, ${publish})
    RETURNING *
  `
  return creation
}

const removeTempFile = async (filePath) => {
  if (!filePath) return
  await fs.rm(filePath, { force: true }).catch(() => {})
}

const requireCloudinary = () => {
  if (!cloudinaryConfigured()) {
    throw Object.assign(
      new Error('Image processing is not configured on this server.'),
      { statusCode: 503, expose: true }
    )
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- text tools

// The frontend sends a number (800 / 1200 / 1600). Each maps to a word range
// that matches the labels on the buttons.
const LENGTH_RANGES = [
  { upTo: 800, min: 500, max: 800 }, //   Short
  { upTo: 1200, min: 800, max: 1200 }, // Medium
  { upTo: Infinity, min: 1200, max: 1600 }, // Long
]

const wordRange = (length) => {
  const target = Number(length) || 800
  return LENGTH_RANGES.find((range) => target <= range.upTo)
}

export const generateArticle = async (req, res, next) => {
  try {
    const { prompt, length } = req.body
    if (!prompt?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: 'A topic is required.' })
    }

    const { min, max } = wordRange(length)
    const content = await generateText(
      `Write a complete, well-structured article in Markdown about "${prompt}". ` +
        `The article must be between ${min} and ${max} words long. ` +
        `Plan it so it finishes naturally: a short introduction, clear headings ` +
        `with full explanations, and a proper conclusion. Never stop mid-sentence. ` +
        `Use short paragraphs and bullet lists where they help. ` +
        `Do not wrap the response in a code fence.`,
      { maxTokens: Math.min(Math.ceil(max * 2.2), 6000) }
    )

    const creation = await saveCreation({
      userId: req.userId,
      prompt,
      content,
      type: 'article',
    })
    await consumeFreeUsage(req)

    res.json({ success: true, content, creation })
  } catch (error) {
    next(error)
  }
}

export const generateBlogTitle = async (req, res, next) => {
  try {
    const { prompt, category } = req.body
    if (!prompt?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: 'A keyword is required.' })
    }

    const content = await generateText(
      `Generate 10 catchy blog title ideas for the keyword "${prompt}" in the ` +
        `"${category || 'General'}" category. Return them as a Markdown list, ` +
        `no preamble and no explanation.`,
      { maxTokens: 500 }
    )

    const creation = await saveCreation({
      userId: req.userId,
      prompt: `Blog titles for "${prompt}" (${category || 'General'})`,
      content,
      type: 'blog-title',
    })
    await consumeFreeUsage(req)

    res.json({ success: true, content, creation })
  } catch (error) {
    next(error)
  }
}

// --------------------------------------------------------------- image tools

// Descriptive wording for each style button. The match is by keyword, so it
// works whether the frontend sends "Ghibli style", "ghibli" or "Ghibli".
const STYLE_PROMPTS = {
  realistic:
    'photorealistic, highly detailed, natural lighting, sharp focus, professional photograph',
  ghibli:
    'Studio Ghibli inspired hand-painted animation style, soft pastel colors, whimsical, detailed painterly background',
  anime:
    'anime style illustration, vibrant colors, clean line art, expressive, cel shading',
  cartoon:
    'colorful cartoon style, bold outlines, playful, flat shading, friendly characters',
  fantasy:
    'epic fantasy art, magical atmosphere, dramatic lighting, intricate detail, concept art',
  watercolour:
    'watercolour painting, soft washes of color, textured paper, delicate brush strokes',
  '3d': '3D render, Pixar-like, smooth materials, soft studio lighting, high detail',
  portrait:
    'professional portrait, detailed face, shallow depth of field, studio lighting',
}

const stylePrompt = (style) => {
  const key = String(style || '').toLowerCase().replace('watercolor', 'watercolour')
  const match = Object.keys(STYLE_PROMPTS).find((name) => key.includes(name))
  return match ? STYLE_PROMPTS[match] : ''
}

/** Turn a ClipDrop failure into a message the user can act on. */
const clipdropFailure = (error) => {
  const status = error.response?.status
  let message = 'The image service failed. Please try again.'
  let statusCode = 502

  if (!status) {
    message = 'Could not reach the image service. Please try again.'
  } else if (status === 400) {
    message = 'The image service rejected that description. Try rewording it.'
    statusCode = 400
  } else if (status === 401 || status === 403) {
    message = 'The image service key is invalid. Check CLIPDROP_API_KEY.'
  } else if (status === 402) {
    message =
      'The image service has no credits left. Add credits to the ClipDrop account.'
    statusCode = 503
  } else if (status === 429) {
    message = 'Too many image requests. Please wait a moment and try again.'
    statusCode = 429
  }

  console.error('ClipDrop request failed:', status ?? error.code, error.message)
  return Object.assign(new Error(message), { statusCode, expose: true })
}

export const generateImage = async (req, res, next) => {
  try {
    requireCloudinary()
    if (!env.clipdropApiKey) {
      return res.status(503).json({
        success: false,
        message: 'Image generation is not configured on this server.',
      })
    }

    const { prompt, style, publish } = req.body
    if (!prompt?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: 'A description is required.' })
    }

    const styleText = stylePrompt(style)
    const fullPrompt = (styleText ? `${prompt.trim()}, ${styleText}` : prompt.trim())
      .slice(0, 1000)

    const form = new FormData()
    form.append('prompt', fullPrompt)

    let data
    try {
      ;({ data } = await axios.post('https://clipdrop-api.co/text-to-image/v1', form, {
        headers: { ...form.getHeaders(), 'x-api-key': env.clipdropApiKey },
        responseType: 'arraybuffer',
        timeout: 120_000,
      }))
    } catch (error) {
      throw clipdropFailure(error)
    }

    const base64Image = `data:image/png;base64,${Buffer.from(data).toString('base64')}`
    const { secure_url } = await cloudinary.uploader.upload(base64Image, {
      folder: 'ai-forge/generated',
    })

    const creation = await saveCreation({
      userId: req.userId,
      prompt: prompt.trim(),
      content: secure_url,
      type: 'image',
      publish: publish === true || publish === 'true',
    })

    res.json({ success: true, content: secure_url, creation })
  } catch (error) {
    next(error)
  }
}

/**
 * Cloudinary builds AI-edited images the first time their URL is requested.
 * Fetch that URL, wait while it is still processing, and turn any failure
 * into a readable message. Returns the finished image bytes.
 */
const fetchProcessedImage = async (url) => {
  let last
  for (let attempt = 0; attempt < 8; attempt += 1) {
    last = await axios
      .get(url, {
        responseType: 'arraybuffer',
        timeout: 90_000,
        validateStatus: () => true,
      })
      .catch(() => null)

    if (last?.status === 200) {
      return {
        buffer: Buffer.from(last.data),
        mimeType: last.headers['content-type'] || 'image/png',
      }
    }
    // 423 means Cloudinary is still processing the transformation.
    if (last?.status === 423) {
      await sleep(3000)
      continue
    }
    break
  }

  const reason = last?.headers?.['x-cld-error']
  console.error('Cloudinary transformation failed:', last?.status, reason)
  throw Object.assign(
    new Error(
      reason
        ? `Image processing failed: ${reason}`
        : 'Image processing failed. Please try again.'
    ),
    { statusCode: 502, expose: true }
  )
}

/** Store the finished image as a normal Cloudinary file and return its URL. */
const saveProcessedImage = async ({ buffer, mimeType }) => {
  const { secure_url } = await cloudinary.uploader.upload(
    `data:${mimeType};base64,${buffer.toString('base64')}`,
    { folder: 'ai-forge/processed' }
  )
  return secure_url
}

export const removeImageBackground = async (req, res, next) => {
  try {
    requireCloudinary()
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: 'An image file is required.' })
    }

    const { public_id } = await cloudinary.uploader.upload(req.file.path, {
      folder: 'ai-forge/uploads',
    })

    const derivedUrl = cloudinary.url(public_id, {
      transformation: [{ effect: 'background_removal' }],
      resource_type: 'image',
      format: 'png',
      secure: true,
    })

    const processed = await fetchProcessedImage(derivedUrl)
    const imageUrl = await saveProcessedImage(processed)

    const creation = await saveCreation({
      userId: req.userId,
      prompt: 'Remove background from image',
      content: imageUrl,
      type: 'image',
    })

    res.json({ success: true, content: imageUrl, creation })
  } catch (error) {
    next(error)
  } finally {
    await removeTempFile(req.file?.path)
  }
}

export const removeImageObject = async (req, res, next) => {
  try {
    requireCloudinary()
    const { object } = req.body
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: 'An image file is required.' })
    }
    if (!object?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Describe the object you want removed.',
      })
    }
    if (object.trim().split(/\s+/).length > 1) {
      return res.status(400).json({
        success: false,
        message: 'Please describe the object in a single word.',
      })
    }

    const { public_id } = await cloudinary.uploader.upload(req.file.path, {
      folder: 'ai-forge/uploads',
    })

    const derivedUrl = cloudinary.url(public_id, {
      transformation: [{ effect: `gen_remove:prompt_${object.trim()}` }],
      resource_type: 'image',
      secure: true,
    })

    const processed = await fetchProcessedImage(derivedUrl)
    const imageUrl = await saveProcessedImage(processed)

    const creation = await saveCreation({
      userId: req.userId,
      prompt: `Remove ${object.trim()} from image`,
      content: imageUrl,
      type: 'image',
    })

    res.json({ success: true, content: imageUrl, creation })
  } catch (error) {
    next(error)
  } finally {
    await removeTempFile(req.file?.path)
  }
}

// -------------------------------------------------------------------- resume

const RESUME_REVIEW_PROMPT =
  'You are an experienced technical recruiter. Review the resume and reply in ' +
  'Markdown with these sections: Overall Impression, Strengths, Weaknesses, ' +
  'Missing Keywords, and Concrete Improvements. Be specific and actionable.'

export const reviewResume = async (req, res, next) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: 'A PDF, JPG or PNG resume is required.' })
    }

    const buffer = await fs.readFile(req.file.path)
    let content

    if (req.file.mimetype === 'application/pdf') {
      // PDF: extract the text first, then review it.
      const parsed = await pdf(buffer)
      const resumeText = parsed.text?.trim()

      if (!resumeText) {
        return res.status(422).json({
          success: false,
          message: 'No readable text found in that PDF.',
        })
      }

      content = await generateText(
        `${RESUME_REVIEW_PROMPT}\n\nResume:\n\n${resumeText.slice(0, 20_000)}`,
        { maxTokens: 2000 }
      )
    } else {
      // JPG or PNG: send the image itself and let Gemini read it.
      content = await generateTextFromImage(
        `${RESUME_REVIEW_PROMPT}\n\nThe resume is in the attached image. ` +
          `Read all of its text carefully first. If the image is not a resume ` +
          `or the text is unreadable, say so instead of guessing.`,
        {
          base64: buffer.toString('base64'),
          mimeType: req.file.mimetype,
          maxTokens: 2000,
        }
      )
    }

    const creation = await saveCreation({
      userId: req.userId,
      prompt: `Review of ${req.file.originalname}`,
      content,
      type: 'resume-review',
    })

    res.json({ success: true, content, creation })
  } catch (error) {
    next(error)
  } finally {
    await removeTempFile(req.file?.path)
  }
}