'use strict';
var vm = require('vm');
var fs = require('fs');
var _ = require('lodash');
//lodash

var Promise = require('bluebird');
var path = require('path');
var childCompiler = require('./lib/compiler.js');
var prettyError = require('./lib/errors.js');
var chunkSorter = require('./lib/chunksorter.js');
Promise.promisifyAll(fs);

function HtmlWebpackPlugin (options) {
  // Default options
  this.options = _.extend({
    template: path.join(__dirname, 'default_index.ejs'),
    //template模版
    filename: 'index.html',
    //文件名
    hash: false,
    //是否添加hash
    inject: true,
    //true | 'head' | 'body' | false Inject all assets into the given template or 
    //templateContent - When passing true or 'body' all javascript resources will be placed at the bottom of the body element. 'head' will place the scripts in the head element.
    compile: true,
    favicon: false,
    //Adds the given favicon path to the output html.
    minify: false,
    //压缩html
    cache: true,
    //true | false if true (default) try to emit the file only if it was changed.
    showErrors: true,
    //是否显示错误信息
    chunks: 'all',
    //Allows you to add only some chunks (e.g. only the unit-test chunk)
    excludeChunks: [],
    //Allows you to skip some chunks (e.g. don't add the unit-test chunk)
    title: 'Webpack App',
    //html页面的title标题
    xhtml: false
    //true | false If true render the link tags as self-closing, XHTML compliant. Default is false
  }, options);
}

HtmlWebpackPlugin.prototype.apply = function (compiler) {
  var self = this;
  var isCompilationCached = false;
  var compilationPromise;
  this.options.template = this.getFullTemplatePath(this.options.template, compiler.context);
  // convert absolute filename into relative so that webpack can
  // generate it at correct location
  var filename = this.options.filename;
  //文件名称

  if (path.resolve(filename) === path.normalize(filename)) {
    this.options.filename = path.relative(compiler.options.output.path, filename);
  }

//这个阶段主要是获取值封装到this上
  compiler.plugin('make', function (compilation, callback) {
    // Compile the template (queued)
    compilationPromise = childCompiler.compileTemplate(self.options.template, compiler.context, self.options.filename, compilation)
      .catch(function (err) {
        //如果报错，为compilation.errors添加错误信息
        compilation.errors.push(prettyError(err, compiler.context).toString());
        return {
          content: self.options.showErrors ? prettyError(err, compiler.context).toJsonHtml() : 'ERROR',
          outputName: self.options.filename
        };
        //返回对象content为错误信息，outputName为通过filename指定的文件名
      })
      .then(function (compilationResult) {
        // If the compilation change didnt change the cache is valid
        isCompilationCached = compilationResult.hash && self.childCompilerHash === compilationResult.hash;
        //这是html文件的hash值
        self.childCompilerHash = compilationResult.hash;
        //赋值childCompilerHash
        self.childCompilationOutputName = compilationResult.outputName;
        //获取输出的文件名
        callback();
        return compilationResult.content;
        //这是文件的真实内容childCompilation.assets[outputName].source()
      });
  });


  //输出文件阶段
  compiler.plugin('emit', function (compilation, callback) {
    var applyPluginsAsyncWaterfall = self.applyPluginsAsyncWaterfall(compilation);
    // Get all chunks
    //获取所有的chunks
    var allChunks = compilation.getStats().toJson().chunks;
    // Filter chunks (options.chunks and options.excludeCHunks)
    //self.options.chunks中的是必须保存的，self.options.excludeChunks必须排除，其他都保存
    var chunks = self.filterChunks(allChunks, self.options.chunks, self.options.excludeChunks);
    // Sort chunks
    chunks = self.sortChunks(chunks, self.options.chunksSortMode);
    // Let plugins alter the chunks and the chunk sorting
    //'html-webpack-plugin-alter-chunks'勾子函数修改chunks，传入的参数self表示该插件实例本身
    chunks = compilation.applyPluginsWaterfall('html-webpack-plugin-alter-chunks', chunks, { plugin: self });
    // Get assets
    var assets = self.htmlWebpackPluginAssets(compilation, chunks);
    // If this is a hot update compilation, move on!
    // This solves a problem where an `index.html` file is generated for hot-update js files
    // It only happens in Webpack 2, where hot updates are emitted separately before the full bundle
    if (self.isHotUpdateCompilation(assets)) {
      return callback();
    }
     
    // If the template and the assets did not change we don't have to emit the html
    //如果template和assets资源没有发生变化，我们不会重新产生html
    var assetJson = JSON.stringify(self.getAssetFiles(assets));
    if (isCompilationCached && self.options.cache && assetJson === self.assetJson) {
      return callback();
    } else {
      self.assetJson = assetJson;
    }

    Promise.resolve()
      // Favicon
      .then(function () {
        if (self.options.favicon) {
          //favicon: Adds the given favicon path to the output html.
          return self.addFileToAssets(self.options.favicon, compilation)
            .then(function (faviconBasename) {
              //faviconBasename返回的是文件名
              var publicPath = compilation.mainTemplate.getPublicPath({hash: compilation.hash}) || '';
              if (publicPath && publicPath.substr(-1) !== '/') {
                publicPath += '/';
              }
              //文件路径
              assets.favicon = publicPath + faviconBasename;
              //assets对象中添加了favicon
            });
        }
      })
      // Wait for the compilation to finish
      //等待compilation完成，返回上面的这个写favicon资源的promise
      .then(function () {
        return compilationPromise;
      })
      .then(function (compiledTemplate) {
        // Allow to use a custom function / string instead
        if (self.options.templateContent !== undefined) {
          return self.options.templateContent;
        }
        // Once everything is compiled evaluate the html factory
        // and replace it with its content
        //如果一切资源已经编译完成，我们执行html工厂函数，使用编译后的结果替代
        return self.evaluateCompilationResult(compilation, compiledTemplate);
      })
      // Allow plugins to make changes to the assets before invoking the template
      // This only makes sense to use if `inject` is `false`
      .then(function (compilationResult) {
        //提供一个勾子函数'html-webpack-plugin-before-html-generation'，传入下面的对象：
        /*
          {
            assets: assets,
            outputName: self.childCompilationOutputName,
            plugin: self
          }
          此时还没有获取到html内容
        */
        return applyPluginsAsyncWaterfall('html-webpack-plugin-before-html-generation', false, {
          assets: assets,
          outputName: self.childCompilationOutputName,
          plugin: self
        })
        .then(function () {
          return compilationResult;
        });
      })
      // Execute the template
      .then(function (compilationResult) {
        // If the loader result is a function execute it to retrieve the html
        // otherwise use the returned html
        //如果loader返回的结果是一个函数，我们执行该函数去获取html内容
        return typeof compilationResult !== 'function'
          ? compilationResult
          : self.executeTemplate(compilationResult, chunks, assets, compilation);
      })
      // Allow plugins to change the html before assets are injected
      //执行勾子函数'html-webpack-plugin-before-html-processing'，此时获取到内容但是没有注入资源
      .then(function (html) {
        var pluginArgs = {html: html, assets: assets, plugin: self, outputName: self.childCompilationOutputName};
        return applyPluginsAsyncWaterfall('html-webpack-plugin-before-html-processing', true, pluginArgs);
      })
      .then(function (result) {
        var html = result.html;
        var assets = result.assets;
        // Prepare script and link tags
        var assetTags = self.generateAssetTags(assets);
        //返回return {head: head, body: body};其中head和body中存放的是一个个的对象
        var pluginArgs = {head: assetTags.head, body: assetTags.body, plugin: self, chunks: chunks, outputName: self.childCompilationOutputName};
        // Allow plugins to change the assetTag definitions
        //定义勾子函数'html-webpack-plugin-alter-asset-tags'允许修改标签名称
        return applyPluginsAsyncWaterfall('html-webpack-plugin-alter-asset-tags', true, pluginArgs)
          .then(function (result) {
              // Add the stylesheets, scripts and so on to the resulting html
            return self.postProcessHtml(html, assets, { body: result.body, head: result.head })
              .then(function (html) {
                //html指的是我们的注入了标签后的html内容
                return _.extend(result, {html: html, assets: assets});
              });
          });
      })
      // Allow plugins to change the html after assets are injected
      .then(function (result) {
        var html = result.html;
        var assets = result.assets;
        //添加一个勾子函数'html-webpack-plugin-after-html-processing'
        var pluginArgs = {html: html, assets: assets, plugin: self, outputName: self.childCompilationOutputName};
        return applyPluginsAsyncWaterfall('html-webpack-plugin-after-html-processing', true, pluginArgs)
          .then(function (result) {
            return result.html;
          });
      })
      .catch(function (err) {
        // In case anything went wrong the promise is resolved
        // with the error message and an error is logged
        compilation.errors.push(prettyError(err, compiler.context).toString());
        // Prevent caching
        self.hash = null;
        //阻止缓存
        return self.options.showErrors ? prettyError(err, compiler.context).toHtml() : 'ERROR';
      })
      .then(function (html) {
        // Replace the compilation result with the evaluated html code
        //使用我们修改后的html内容来替换本来的内容
        compilation.assets[self.childCompilationOutputName] = {
          source: function () {
            return html;
          },
          size: function () {
            return html.length;
          }
        };
      })
      .then(function () {
        // Let other plugins know that we are done:
        //'html-webpack-plugin-after-emit'勾子函数，让其他插件知道该插件做了什么事情
        return applyPluginsAsyncWaterfall('html-webpack-plugin-after-emit', false, {
          html: compilation.assets[self.childCompilationOutputName],
          outputName: self.childCompilationOutputName,
          plugin: self
        }).catch(function (err) {
          console.error(err);
          return null;
        }).then(function () {
          return null;
        });
      })
      // Let webpack continue with it
      .finally(function () {
        callback();
        // Tell blue bird that we don't want to wait for callback.
        //让blue bird知道我们不需要等待回调了
        // Fixes "Warning: a promise was created in a handler but none were returned from it"
        // https://github.com/petkaantonov/bluebird/blob/master/docs/docs/warning-explanations.md#warning-a-promise-was-created-in-a-handler-but-none-were-returned-from-it
        return null;
      });
  });
};

/**
 * Evaluates the child compilation result
 * Returns a promise
 调用：self.evaluateCompilationResult(compilation, compiledTemplate);
 */
HtmlWebpackPlugin.prototype.evaluateCompilationResult = function (compilation, source) {
  if (!source) {
    return Promise.reject('The child compilation didn\'t provide a result');
  }
  // The LibraryTemplatePlugin stores the template result in a local variable.
  // To extract the result during the evaluation this part has to be removed.
  source = source.replace('var HTML_WEBPACK_PLUGIN_RESULT =', '');
  //LibraryTemplatePlugin把template的结果保存在局部变量中
  var template = this.options.template.replace(/^.+!/, '').replace(/\?.+$/, '');
  var vmContext = vm.createContext(_.extend({HTML_WEBPACK_PLUGIN: true, require: require}, global));
  var vmScript = new vm.Script(source, {filename: template});
  // Evaluate code and cast to string
  var newSource;
  try {
    newSource = vmScript.runInContext(vmContext);
  } catch (e) {
    return Promise.reject(e);
  }
  if (typeof newSource === 'object' && newSource.__esModule && newSource.default) {
    newSource = newSource.default;
  }
  return typeof newSource === 'string' || typeof newSource === 'function'
    ? Promise.resolve(newSource)
    : Promise.reject('The loader "' + this.options.template + '" didn\'t return html.');
};

/**
 * Html post processing
 *
 * Returns a promise
 */
HtmlWebpackPlugin.prototype.executeTemplate = function (templateFunction, chunks, assets, compilation) {
  var self = this;
  return Promise.resolve()
    // Template processing
    .then(function () {
      var templateParams = {
        compilation: compilation,
        webpack: compilation.getStats().toJson(),
        webpackConfig: compilation.options,
        htmlWebpackPlugin: {
          files: assets,
          options: self.options
        }
      };
      var html = '';
      try {
        html = templateFunction(templateParams);
      } catch (e) {
        compilation.errors.push(new Error('Template execution failed: ' + e));
        return Promise.reject(e);
      }
      return html;
    });
};

/**
 * Html post processing
 *调用：self.postProcessHtml(html, assets, { body: result.body, head: result.head })
 * Returns a promise
 html表示html文件的内容

 */
HtmlWebpackPlugin.prototype.postProcessHtml = function (html, assets, assetTags) {
  var self = this;
  if (typeof html !== 'string') {
    return Promise.reject('Expected html to be a string but got ' + JSON.stringify(html));
  }
  return Promise.resolve()
    // Inject
    .then(function () {
      //如果配置了inject那么调用injectAssetsIntoHtml得到注入到html后的内容，否则返回html字符串本身
      if (self.options.inject) {
        return self.injectAssetsIntoHtml(html, assets, assetTags);
      } else {
        return html;
      }
    })
    // Minify
    //压缩html文件
    .then(function (html) {
      if (self.options.minify) {
        var minify = require('html-minifier').minify;
        return minify(html, self.options.minify);
      }
      return html;
    });
};

/*
 * Pushes the content of the given filename to the compilation assets
 调用方式：self.addFileToAssets(self.options.favicon, compilation)
 */
HtmlWebpackPlugin.prototype.addFileToAssets = function (filename, compilation) {
  filename = path.resolve(compilation.compiler.context, filename);
  //获取文件的绝对路径
  return Promise.props({
    size: fs.statAsync(filename),
    source: fs.readFileAsync(filename)
  })
  .catch(function () {
    return Promise.reject(new Error('HtmlWebpackPlugin: could not load file ' + filename));
  })
  .then(function (results) {
    var basename = path.basename(filename);
    //path.basename('/foo/bar/baz/asdf/quux.html')
     // Returns: 'quux.html'
     //获取文件名称
    compilation.fileDependencies.push(filename);
    //在compilation.fileDependencies中添加文件，filename是完整的文件路径
    compilation.assets[basename] = {
      source: function () {
        return results.source;
      },
      //source是文件的内容，通过fs.readFileAsync完成
      size: function () {
        return results.size.size;
        //size通过 fs.statAsync(filename)完成
      }
    };
    return basename;
  });
};

/**
 * Helper to sort chunks

 sortMode如下方式：

 undefined:'auto'（通过id排序）

 function: '调用该函数'

 'none' :调用方式直接返回chunks不做任何处理
 */
HtmlWebpackPlugin.prototype.sortChunks = function (chunks, sortMode) {
  // Sort mode auto by default:
  if (typeof sortMode === 'undefined') {
    sortMode = 'auto';
  }
  // Custom function
  if (typeof sortMode === 'function') {
    return chunks.sort(sortMode);
  }
  // Disabled sorting:
  if (sortMode === 'none') {
    return chunkSorter.none(chunks);
  }
  // Check if the given sort mode is a valid chunkSorter sort mode
  if (typeof chunkSorter[sortMode] !== 'undefined') {
    return chunkSorter[sortMode](chunks);
  }
  throw new Error('"' + sortMode + '" is not a valid chunk sort mode');
};

/**
 * Return all chunks from the compilation result which match the exclude and include filters
 */
HtmlWebpackPlugin.prototype.filterChunks = function (chunks, includedChunks, excludedChunks) {
  return chunks.filter(function (chunk) {
    var chunkName = chunk.names[0];
    // This chunk doesn't have a name. This script can't handled it.
    //chunk实例只有一个name属性，此处采用的是names[0]
    if (chunkName === undefined) {
      return false;
    }
    // Skip if the chunk should be lazy loaded
    //如果是require.ensure产生的chunk直接忽略
    if (!chunk.initial) {
      return false;
    }
    // Skip if the chunks should be filtered and the given chunk was not added explicity
    //这个chunk必须在includedchunks里面
    if (Array.isArray(includedChunks) && includedChunks.indexOf(chunkName) === -1) {
      return false;
    }
    // Skip if the chunks should be filtered and the given chunk was excluded explicity
    //这个chunk不能在excludedChunks中
    if (Array.isArray(excludedChunks) && excludedChunks.indexOf(chunkName) !== -1) {
      return false;
    }
    // Add otherwise
    //也就是说：该chunk要被选中的条件是：有名称，不是懒加载，在includedChunks中但是不在excludedChunks中
    return true;
  });
};


//调用方式：self.isHotUpdateCompilation(assets)，这些资源htmlWebpackPluginAssets方法返回的
HtmlWebpackPlugin.prototype.isHotUpdateCompilation = function (assets) {
  //如果每一个js的文件名，也就是入口文件都含有hot-update字段那么返回true
  return assets.js.length && assets.js.every(function (name) {
    return /\.hot-update\.js$/.test(name);
  });
};

//调用方式self.htmlWebpackPluginAssets(compilation, chunks);
HtmlWebpackPlugin.prototype.htmlWebpackPluginAssets = function (compilation, chunks) {
  var self = this;
  var webpackStatsJson = compilation.getStats().toJson();
  //获取compilation的所有的信息
  // Use the configured public path or build a relative path
  var publicPath = typeof compilation.options.output.publicPath !== 'undefined'
    // If a hard coded public path exists use it
    ? compilation.mainTemplate.getPublicPath({hash: webpackStatsJson.hash})
    // If no public path was set get a relative url path
    : path.relative(path.resolve(compilation.options.output.path, path.dirname(self.childCompilationOutputName)), compilation.options.output.path)
      .split(path.sep).join('/');
    //得到publicpath

    if (publicPath.length && publicPath.substr(-1, 1) !== '/') {
      publicPath += '/';
    }
    //获取倒数第一个字符

  var assets = {
    // The public path
    publicPath: publicPath,
    // Will contain all js & css files by chunk
    chunks: {},
    // Will contain all js files
    js: [],
    // Will contain all css files
    css: [],
    // Will contain the html5 appcache manifest files if it exists
    //这里是application cache文件，这里不是文件内容是文件的名称
    manifest: Object.keys(compilation.assets).filter(function (assetFile) {
      return path.extname(assetFile) === '.appcache';
    })[0]
  };

  // Append a hash for cache busting（缓存清除）
  //hash: true | false if true then append a unique webpack compilation hash to all
  // included scripts and CSS files. This is useful for cache busting.
  if (this.options.hash) {
    assets.manifest = self.appendHash(assets.manifest, webpackStatsJson.hash);
    assets.favicon = self.appendHash(assets.favicon, webpackStatsJson.hash);
  }

  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i];
    var chunkName = chunk.names[0];
    //为每一个chunk都在上面的这个assets对象上添加一个对象，如assets.chunks[chunkName]={}
    assets.chunks[chunkName] = {};
    // Prepend the public path to all chunk files
    //chunk.files表示该chunk产生的所有的文件，不过是文件名称name而不是内容
    var chunkFiles = [].concat(chunk.files).map(function (chunkFile) {
      return publicPath + chunkFile;
    });

    // Append a hash for cache busting
    //为每一个文件加上了publicPath同时还要加上hash
    if (this.options.hash) {
      chunkFiles = chunkFiles.map(function (chunkFile) {
        return self.appendHash(chunkFile, webpackStatsJson.hash);
      });
    }

    // Webpack outputs an array for each chunk when using sourcemaps
    // But we need only the entry file
    //chunk.files[0]就是该chunk产生的入口文件
    var entry = chunkFiles[0];
    assets.chunks[chunkName].size = chunk.size;
    assets.chunks[chunkName].entry = entry;
    assets.chunks[chunkName].hash = chunk.hash;
    assets.js.push(entry);
    //为每一个该chunk产生的文件都在上面的assets对象上添加一个对象，key是chunkName
    //value为一个对象{chunkName:{size:100,entry:'/qlin/',hash:'chunk的hash'}}

    // Gather all css files
    var css = chunkFiles.filter(function (chunkFile) {
      // Some chunks may contain content hash in their names, for ex. 'main.css?1e7cac4e4d8b52fd5ccd2541146ef03f'.
      // We must proper handle such cases, so we use regexp testing here
      return /.css($|\?)/.test(chunkFile);
    });
    assets.chunks[chunkName].css = css;
    //css属性就是我们的文件路径
    assets.css = assets.css.concat(css);
  }

  // Duplicate css assets can occur on occasion if more than one chunk
  // requires the same css.
  assets.css = _.uniq(assets.css);
  //如果多个chunk使用了同一个css那么会产生重复的css
  return assets;
};

/**
 * Injects the assets into the given html string
 */
HtmlWebpackPlugin.prototype.generateAssetTags = function (assets) {
  // Turn script files into script tags
  //把script文件插入到script标签中
  var scripts = assets.js.map(function (scriptPath) {
    return {
      tagName: 'script',
      closeTag: true,
      attributes: {
        type: 'text/javascript',
        src: scriptPath
      }
    };
  });
  // Make tags self-closing in case of xhtml
  //在xhtml中script标签必须是关闭的
  var selfClosingTag = !!this.options.xhtml;
  // Turn css files into link tags
  var styles = assets.css.map(function (stylePath) {
    return {
      tagName: 'link',
      selfClosingTag: selfClosingTag,
      attributes: {
        href: stylePath,
        rel: 'stylesheet'
      }
    };
  });
  // Injection targets
  var head = [];
  var body = [];
  // If there is a favicon present, add it to the head
  if (assets.favicon) {
    head.push({
      tagName: 'link',
      selfClosingTag: selfClosingTag,
      attributes: {
        rel: 'shortcut icon',
        href: assets.favicon
      }
    });
  }
  // Add styles to the head
  //将style添加到head中
  head = head.concat(styles);
  // Add scripts to body or head
  //如果inject为head那么script放入head，否则放入body中
  if (this.options.inject === 'head') {
    head = head.concat(scripts);
  } else {
    body = body.concat(scripts);
  }
  //返回的事head和body数组
  return {head: head, body: body};
};

/**
 * Injects the assets into the given html string
 调用方式：self.injectAssetsIntoHtml(html, assets, assetTags);
 */
HtmlWebpackPlugin.prototype.injectAssetsIntoHtml = function (html, assets, assetTags) {
  var htmlRegExp = /(<html[^>]*>)/i;
  var headRegExp = /(<\/head>)/i;
  var bodyRegExp = /(<\/body>)/i;
  var body = assetTags.body.map(this.createHtmlTag);
  var head = assetTags.head.map(this.createHtmlTag);
  //其中body就是所有的创建的需要添加到body中的标签的集合，而head就是所有需要添加到head中的标签的集合
  if (body.length) {
    if (bodyRegExp.test(html)) {
      // Append assets to body element
      html = html.replace(bodyRegExp, function (match) {
        return body.join('') + match;
        //这里的match标签就是我们的body标签
      });
    } else {
      // Append scripts to the end of the file if no <body> element exists:
      html += body.join('');
    }
  }

  if (head.length) {
    // Create a head tag if none exists
    //如果没有head标签我们直接创建
    if (!headRegExp.test(html)) {
      if (!htmlRegExp.test(html)) {
        html = '<head></head>' + html;
      } else {
        html = html.replace(htmlRegExp, function (match) {
          return match + '<head></head>';
        });
      }
    }
    // Append assets to head element
    html = html.replace(headRegExp, function (match) {
      return head.join('') + match;
    //添加到head中
    });
  }
  // Inject manifest into the opening html tag
  //在html标签中添加manifest文件
  if (assets.manifest) {
    html = html.replace(/(<html[^>]*)(>)/i, function (match, start, end) {
      // Append the manifest only if no manifest was specified
      if (/\smanifest\s*=/.test(match)) {
        return match;
      }
      return start + ' manifest="' + assets.manifest + '"' + end;
    });
  }
  return html;
};

/**
 * Appends a cache busting hash
 self.appendHash(assets.manifest, webpackStatsJson.hash);
 为文件名称后面添加一个hash值用于缓存，是在文件的路径上而不是内容
 */
HtmlWebpackPlugin.prototype.appendHash = function (url, hash) {
  if (!url) {
    return url;
  }
  return url + (url.indexOf('?') === -1 ? '?' : '&') + hash;
};

/**
 * Turn a tag definition into a html string
 调用方式如下：
  var body = assetTags.body.map(this.createHtmlTag);
  var head = assetTags.head.map(this.createHtmlTag);
其中body中的元素如下：
 {
      tagName: 'script',
      closeTag: true,
      attributes: {
        type: 'text/javascript',
        src: scriptPath
      }
    };
 */
HtmlWebpackPlugin.prototype.createHtmlTag = function (tagDefinition) {
  var attributes = Object.keys(tagDefinition.attributes || {})
    .filter(function (attributeName) {
      return tagDefinition.attributes[attributeName] !== false;
    })
    //如果属性为falsename我们不会处理的
    .map(function (attributeName) {
      //如果value是true,那么直接返回key就可以了
      if (tagDefinition.attributes[attributeName] === true) {
        return attributeName;
      }
      return attributeName + '="' + tagDefinition.attributes[attributeName] + '"';
    });
  //此时变成了src=""这种类型了

  // Backport of 3.x void tag definition
  //这里是补丁
  var voidTag = tagDefinition.voidTag !== undefined ? tagDefinition.voidTag : !tagDefinition.closeTag;
  //如果指定了voidTag那么直接获取，否则取closeTag的反义
  var selfClosingTag = tagDefinition.voidTag !== undefined ? tagDefinition.voidTag && this.options.xhtml : tagDefinition.selfClosingTag;
  //如果是xhtml，所以要判断selfClosingTag
  return '<' + [tagDefinition.tagName].concat(attributes).join(' ') + (selfClosingTag ? '/' : '') + '>' +
    (tagDefinition.innerHTML || '') +
    (voidTag ? '' : '</' + tagDefinition.tagName + '>');
};


/**
 * Helper to return the absolute template path with a fallback loader

   调用方式：
   this.options.template = this.getFullTemplatePath(this.options.template, compiler.context);
   compiler.context指的是当前项目的路径https://github.com/liangklfangl/commonsChunkPlugin_Config
 */
HtmlWebpackPlugin.prototype.getFullTemplatePath = function (template, context) {
  // If the template doesn't use a loader use the lodash template loader
  //如果template没有使用loader，那么使用lodash template loader,表示对于特定的文件我们使用特定的loader
  if (template.indexOf('!') === -1) {
    template = require.resolve('./lib/loader.js') + '!' + path.resolve(context, template);
  }
  // Resolve template path
  return template.replace(
    /([!])([^/\\][^!?]+|[^/\\!?])($|\?[^!?\n]+$)/,
    function (match, prefix, filepath, postfix) {
      return prefix + path.resolve(filepath) + postfix;
    });
};

/**
 * Helper to return a sorted unique array of all asset files out of the
 * asset object
 调用：var assetJson = JSON.stringify(self.getAssetFiles(assets));
 其中key是数组下标
 */
HtmlWebpackPlugin.prototype.getAssetFiles = function (assets) {
  var files = _.uniq(Object.keys(assets).filter(function (assetType) {
    return assetType !== 'chunks' && assets[assetType];
    //获取类型不是chunks的资源
  }).reduce(function (files, assetType) {
    return files.concat(assets[assetType]);
  }, []));
  files.sort();
  return files;
};

/**
 * Helper to promisify compilation.applyPluginsAsyncWaterfall that returns
 * a function that helps to merge given plugin arguments with processed ones
 */
HtmlWebpackPlugin.prototype.applyPluginsAsyncWaterfall = function (compilation) {
  var promisedApplyPluginsAsyncWaterfall = Promise.promisify(compilation.applyPluginsAsyncWaterfall, {context: compilation});
  return function (eventName, requiresResult, pluginArgs) {
    return promisedApplyPluginsAsyncWaterfall(eventName, pluginArgs)
      .then(function (result) {
        if (requiresResult && !result) {
          compilation.warnings.push(new Error('Using ' + eventName + ' without returning a result is deprecated.'));
        }
        return _.extend(pluginArgs, result);
      });
  };
};

module.exports = HtmlWebpackPlugin;
