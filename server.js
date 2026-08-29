const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

// Middleware to check for AUTHORIZATION header (optional for now)
app.use((req, res, next) => {
  const apiKey = req.headers['authorization'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});


class BigFinishProvider {
  constructor() {
    this.id = 'bigfinish';
    this.name = 'BigFinish';
    this.baseUrl = 'https://www.bigfinish.com';
    this.apiSearchUrl = 'https://www.bigfinish.com/api/search';
  }

  // FAST: Returns all search results in a single API call
  async searchBooks(query, author = '') {
    try {
      const fullQuery = author ? `${query} ${author}`.trim() : query.trim();
      const response = await axios.post(
        this.apiSearchUrl,
        { q: fullQuery, limit: 30, offset: 0 },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          }
        }
      );

      const allHits = response.data?.hits || [];
      const releaseHits = allHits.filter(
        hit => hit.indexUid === 'audiobook_models' || Boolean(hit.release_slug)
      );

      const matches = releaseHits.map(hit => {
        const contributorNames = Array.isArray(hit.contributors)
          ? hit.contributors.map(c => (typeof c === 'string' ? c : c.name)).filter(Boolean)
          : [];

        return {
          id: String(hit.id),
          title: hit.name || hit.title,
          url: `${this.baseUrl}/releases/v/${hit.release_slug || hit.id}`,
          cover: hit.image || null,
          description: hit.description || null,
          narrator: contributorNames.join(', ') || null,
          authors: contributorNames,
          duration: hit.duration ? `${hit.duration} mins` : null,
          type: hit.release_edition || 'Audiobook',
          publisher: 'Big Finish Productions',
          source: { id: this.id, description: this.name, link: this.baseUrl }
        };
      });

      return { matches };
    } catch (error) {
      console.error('[BigFinish] searchBooks error:', error.message);
      return { matches: [] };
    }
  }

 /**
   * Fetch full, rich metadata for a specific release detail page
   * @param {Object|string} matchOrUrl Either the match object from searchBooks or a URL string
   * @returns {Promise<Object>}
   */
  async getFullMetadata(matchOrUrl) {
    const match = typeof matchOrUrl === 'string' ? { url: matchOrUrl } : { ...matchOrUrl };
    if (!match.url) return match;

    try {
      console.log(`[BigFinish] Fetching full details for: ${match.title || match.url}`);

      const response = await axios.get(match.url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      const $ = cheerio.load(response.data);

      // Base metadata object initialized with any search match data
      const metadata = {
        id: match.id || match.url.split('/').filter(Boolean).pop(),
        title: match.title || $('h1').first().text().trim(),
        url: match.url,
        cover: match.cover || null,
        description: match.description || null,
        authors: Array.isArray(match.authors) ? [...match.authors] : [],
        narrator: match.narrator || null,
        cast: [],
        director: null,
        duration: match.duration || null,
        publishedDate: null,
        publishedYear: match.publishedYear || null,
        isbn: null,
        format: match.type || null,
        publisher: 'Big Finish Productions',
        stories: [], // For multi-story boxsets
        identifiers: {
          bigfinish: match.id || match.url.split('/').filter(Boolean).pop(),
          slug: match.url.split('/releases/v/')[1] || null,
        },
        source: {
          id: this.id,
          description: this.name,
          link: this.baseUrl,
        },
      };

      // =========================================================================
      // STRATEGY 1: Parse Schema.org JSON-LD (Most reliable on Next.js)
      // =========================================================================
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const raw = JSON.parse($(el).html());
          const items = Array.isArray(raw) ? raw : (raw['@graph'] || [raw]);

          for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            const type = item['@type'];
            if (['Product', 'Audiobook', 'Book', 'CreativeWork', 'MusicAlbum'].includes(type)) {
              if (item.name && !metadata.title) metadata.title = item.name;
              if (item.description && !metadata.description) metadata.description = item.description;

              // Cover Image
              if (item.image) {
                const img = Array.isArray(item.image) ? item.image[0] : item.image;
                const imgUrl = typeof img === 'string' ? img : img.url;
                if (imgUrl) metadata.cover = imgUrl;
              }

              // Authors / Writers
              if (item.author) {
                const authors = Array.isArray(item.author) ? item.author : [item.author];
                const names = authors.map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean);
                if (names.length > 0) metadata.authors = names;
              }

              // Actors / Narrators
              if (item.readBy || item.actor || item.performer) {
                const cast = item.readBy || item.actor || item.performer;
                const castList = Array.isArray(cast) ? cast : [cast];
                const castNames = castList.map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean);
                if (castNames.length > 0) {
                  metadata.cast = castNames;
                  metadata.narrator = castNames.join(', ');
                }
              }

              // Release Date
              const date = item.datePublished || item.releaseDate;
              if (date) {
                metadata.publishedDate = String(date);
                const year = String(date).match(/\b(\d{4})\b/);
                if (year) metadata.publishedYear = year[1];
              }

              // ISBN / Barcode / SKU
              if (item.isbn) metadata.isbn = item.isbn;
              if (item.sku && !metadata.identifiers.sku) metadata.identifiers.sku = item.sku;
            }
          }
        } catch (_) {
          // Ignore JSON-LD parse errors
        }
      });

      // =========================================================================
      // STRATEGY 2: DOM Parsing (Extract specific labelled metadata blocks)
      // =========================================================================

      // Helper: Find value associated with a metadata label across varied markup
      const findMetadataValue = (labelKeywords) => {
        for (const keyword of labelKeywords) {
          // 1. Definition lists: <dt>Label</dt><dd>Value</dd>
          const dt = $(`dt:contains("${keyword}")`).first();
          if (dt.length > 0) {
            const dd = dt.next('dd');
            if (dd.length > 0) return dd.text().trim();
          }

          // 2. Headings/Spans followed by sibling/parent text
          const labelEl = $(`*:contains("${keyword}")`)
            .filter((_, el) => {
              const text = $(el).children().remove().end().text().trim();
              return text.toLowerCase().startsWith(keyword.toLowerCase());
            })
            .first();

          if (labelEl.length > 0) {
            // Check parent or adjacent container for links/spans
            const container = labelEl.closest('div, li, p, section');
            const links = container.find('a').map((_, a) => $(a).text().trim()).get().filter(Boolean);
            if (links.length > 0) return links;

            const rawText = container.text().replace(new RegExp(`^.*?${keyword}[:\\s]*`, 'i'), '').trim();
            if (rawText) return rawText;
          }
        }
        return null;
      };

      // 1. Written By / Authors
      if (metadata.authors.length === 0) {
        const writersFound = findMetadataValue(['Written By', 'Written by', 'Author', 'Adapted By', 'Adapted by']);
        if (writersFound) {
          metadata.authors = Array.isArray(writersFound)
            ? writersFound
            : writersFound.split(/,\s*|\s+and\s+/i).map((w) => w.trim()).filter(Boolean);
        }
      }

      // 2. Starring / Cast / Narrators
      if (!metadata.narrator || metadata.cast.length === 0) {
        const castFound = findMetadataValue(['Starring', 'Cast', 'Narrated by', 'Read by']);
        if (castFound) {
          const castArray = Array.isArray(castFound)
            ? castFound
            : castFound.split(/,\s*|\s+and\s+/i).map((c) => c.trim()).filter(Boolean);

          metadata.cast = [...new Set(castArray)];
          metadata.narrator = metadata.cast.join(', ');
        }
      }

      // 3. Director
      if (!metadata.director) {
        const directorFound = findMetadataValue(['Directed By', 'Directed by', 'Director']);
        if (directorFound) {
          metadata.director = Array.isArray(directorFound) ? directorFound.join(', ') : directorFound;
        }
      }

      // 4. Duration
      if (!metadata.duration) {
        const durFound = findMetadataValue(['Duration', 'Running Time', 'Length']);
        if (durFound) {
          const durStr = Array.isArray(durFound) ? durFound.join(' ') : durFound;
          metadata.duration = durStr.replace(/^duration:?\s*/i, '').trim();
        }
      }

      // 5. Release Date & Published Year
      if (!metadata.publishedYear || !metadata.publishedDate) {
        const dateFound = findMetadataValue(['Released', 'Release Date', 'Published']);
        if (dateFound) {
          const dateStr = Array.isArray(dateFound) ? dateFound.join(' ') : dateFound;
          metadata.publishedDate = dateStr;
          const yearMatch = dateStr.match(/\b(\d{4})\b/);
          if (yearMatch) metadata.publishedYear = yearMatch[1];
        }
      }

      // 6. Detailed Synopsis & Story Breakdown
      const synopsisContainer = $('[class*="synopsis"], [class*="description"], article, main section')
        .filter((_, el) => $(el).find('p').length > 0)
        .first();

      if (synopsisContainer.length > 0) {
        const paragraphs = synopsisContainer
          .find('p')
          .map((_, el) => $(el).text().trim())
          .get()
          .filter((t) => t.length > 0 && !t.includes('**THIS TITLE IS NOW OUT OF PRINT'));

        if (paragraphs.length > 0) {
          metadata.description = paragraphs.join('\n\n');
        }

        // Detect multiple stories in anthology/box sets (e.g. "1. Story Name by Author")
        const stories = [];
        synopsisContainer.find('p').each((_, p) => {
          const strongText = $(p).find('strong, b').first().text().trim();
          if (strongText && /^\d+\.|\bby\b/i.test(strongText)) {
            stories.push({
              title: strongText,
              synopsis: $(p).text().replace(strongText, '').trim(),
            });
          }
        });
        if (stories.length > 0) metadata.stories = stories;
      }

      // 7. High-Res Cover Art Fallback
      if (!metadata.cover) {
        const img = $('main img[src*="admin.bigfinish.com"], main img[src*="asset"], main img[alt*="cover" i]').first();
        if (img.length > 0) {
          const src = img.attr('src') || img.attr('data-src');
          if (src) metadata.cover = src.startsWith('http') ? src : new URL(src, this.baseUrl).toString();
        }
      }

      console.log(`[BigFinish] Full metadata resolved for: ${metadata.title}`);
      return metadata;
    } catch (error) {
      console.error(`[BigFinish] Error resolving full metadata for ${match.url}:`, error.message);
      return match;
    }
  }
}

module.exports = BigFinishProvider;
const provider = new BigFinishProvider();
// --- Runner ---
// (async () => {
  // const provider = new BigFinishProvider();
  // const results = await provider.searchBooks('The Cosmos and Mrs. Clarke');
  // console.log('\n=== Final Result Object ===');
  // console.dir(results, { depth: null, colors: true });
// })();
// Search route
app.get('/search', async (req, res) => {
  try {
    console.log('Received search request:', req.query);
    const query = req.query.query;
    const author = req.query.author;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    const results = await provider.searchBooks(query, author);

    // Format results according to OpenAPI specification
    const formattedResults = {
      matches: results.matches.map(book => ({
        title: book.title,
        subtitle: book.subtitle || undefined,
        author: book.authors ? book.authors.join(', ') : undefined, // List authors if available
        narrator: book.narrator || undefined,
        description: book.description ? (typeof book.description === 'string' ? book.description : book.description.description) : undefined, // Only include matching story's description
        cover: book.cover || undefined,
        duration: book.duration || undefined,
        type: book.type || undefined,
        publishedYear: book.publishedYear || undefined, // Include the published year
        publisher: book.publisher || 'Big Finish Productions', // Always include publisher
      }))
    };

    console.log('Sending response:', JSON.stringify(formattedResults, null, 2));
    res.json(formattedResults);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`BigFinish provider listening on port ${port}`);
});
