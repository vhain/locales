/**!
 * koa-locales - index.js
 *
 * Copyright(c) koajs and other contributors.
 * MIT Licensed
 *
 * Authors:
 *   fengmk2 <m@fengmk2.com> (http://fengmk2.com)
 */

'use strict';

/**
 * Module dependencies.
 */

const debug = require('debug')('koa-locales');
const ini = require('ini');
const util = require('util');
const fs = require('fs');
const path = require('path');
const ms = require('humanize-ms');
const assign = require('object-assign');

const DEFAULT_OPTIONS = {
  defaultLocale: 'en-US',
  queryField: 'locale',
  cookieField: 'locale',
  cookieMaxAge: '1y',
  dir: undefined,
  dirs: [path.join(process.cwd(), 'locales')],
  functionName: '__',
};

module.exports = function (app, options) {
  options = assign({}, DEFAULT_OPTIONS, options);
  const defaultLocale = formatLocale(options.defaultLocale);
  const queryField = options.queryField;
  const cookieField = options.cookieField;
  const cookieMaxAge = ms(options.cookieMaxAge);
  const localeDir = options.dir;
  const localeDirs = options.dirs;
  const functionName = options.functionName;
  const resources = {};

  /**
   * @Deprecated Use options.dirs instead.
   */
  if (localeDir && localeDirs.indexOf(localeDir) === -1) {
    localeDirs.push(localeDir);
  }

  for (let i = 0; i < localeDirs.length; i++) {
    const dir = localeDirs[i];

    if (!fs.existsSync(dir)) {
      continue;
    }

    const names = fs.readdirSync(dir);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const filepath = path.join(dir, name);
      // support en_US.js => en-US.js
      const locale = formatLocale(name.split('.')[0]);
      let resource = {};

      if (name.endsWith('.js') || name.endsWith('.json')) {
        resource = flattening(require(filepath));
      } else if (name.endsWith('.properties')) {
        resource = ini.parse(fs.readFileSync(filepath, 'utf8'));
      }

      resources[locale] = resources[locale] || {};
      assign(resources[locale], resource);
    }
  }

  debug('init locales with %j, got %j resources', options, Object.keys(resources));

  app.context[functionName] = function (key, value) {
    if (arguments.length === 0) {
      // __()
      return '';
    }

    const locale = this.__getLocale();
    const resource = resources[locale] || {};

    const text = resource[key] || key;
    debug('%s: %j => %j', locale, key, text);
    if (!text) {
      return '';
    }

    if (arguments.length === 1) {
      // __(key)
      return text;
    }
    if (arguments.length === 2) {
      if (isObject(value)) {
        // __(key, object)
        // __('{a} {b} {b} {a}', {a: 'foo', b: 'bar'})
        // =>
        // foo bar bar foo
        return formatWithObject(text, value);
      }

      if (Array.isArray(value)) {
        // __(key, array)
        // __('{0} {1} {1} {0}', ['foo', 'bar'])
        // =>
        // foo bar bar foo
        return formatWithArray(text, value);
      }

      // __(key, value)
      return util.format(text, value);
    }

    // __(key, value1, ...)
    const args = new Array(arguments.length);
    args[0] = text;
    for(let i = 1; i < args.length; i++) {
      args[i] = arguments[i];
    }
    return util.format.apply(util, args);
  };

  // 1. query: /?locale=en-US
  // 2. cookie: locale=zh-TW
  // 3. header: Accept-Language: zh-CN,zh;q=0.5
  app.context.__getLocale = function () {
    if (this.__locale) {
      return this.__locale;
    }

    const cookieLocale = this.cookies.get(cookieField);
    let locale = this.query[queryField] || cookieLocale;
    if (!locale) {
      // Accept-Language: zh-CN,zh;q=0.5
      // Accept-Language: zh-CN
      let languages = this.acceptsLanguages();
      if (languages) {
        if (Array.isArray(languages)) {
          if (languages[0] === '*') {
            languages = languages.slice(1);
          }
          if (languages.length > 0) {
            for (let i = 0; i < languages.length; i++) {
              var lang = formatLocale(languages[i]);
              var loc = bestLocaleMatch(resources, lang)

              if (!!loc) {
                locale = lang;
                break;
              }
            }
            if (!locale) {
              // set the first one
              locale = languages[0];
            }
          }
        } else {
          locale = languages;
        }
      }

      // all missing, set it to defaultLocale
      if (!locale) {
        locale = defaultLocale;
      }
    }

    locale = formatLocale(locale);

    // validate locale
    locale = bestLocaleMatch(resources, locale);
    if (!locale) {
      locale = defaultLocale;
    }

    if (cookieLocale !== locale) {
      // locale change, need to set cookie
      this.cookies.set(cookieField, locale, {
        // make sure brower javascript can read the cookie
        httpOnly: false,
        maxAge: cookieMaxAge,
      });
    }
    this.__locale = locale;
    return locale;
  };
};

function bestLocaleMatch(resources, lang) {
  var locale = null;

  while (true) {
    if (resources[lang]) {
      locale = lang;
      break;
    }

    let lastIndex = lang.lastIndexOf('-');
    if (lastIndex < 0) break;

    lang = lang.substr(0, lang.lastIndexOf('-'))
  }

  return locale;
}

function isObject(obj) {
  return Object.prototype.toString.call(obj) === '[object Object]';
}

const ARRAY_INDEX_RE = /\{(\d+)\}/g;
function formatWithArray(text, values) {
  return text.replace(ARRAY_INDEX_RE, function (orignal, matched) {
    const index = parseInt(matched);
    if (index < values.length) {
      return values[index];
    }
    // not match index, return orignal text
    return orignal;
  });
}

const Object_INDEX_RE = /\{(.+?)\}/g;
function formatWithObject(text, values) {
  return text.replace(Object_INDEX_RE, function (orignal, matched) {
    const value = values[matched];
    if (value) {
      return value;
    }
    // not match index, return orignal text
    return orignal;
  });
}

function formatLocale(locale) {
  // support zh_CN, en_US => zh-CN, en-US
  return locale.replace('_', '-').toLowerCase();
}

function flattening(data) {

  const result = {};

  function deepFlat (data, keys) {
    Object.keys(data).forEach(function(key) {
      const value = data[key];
      const k = keys ? keys + '.' + key : key;
      if (isObject(value)) {
        deepFlat(value, k);
      } else {
        result[k] = String(value);
      }
    });
  }

  deepFlat(data, '');

  return result;
}
