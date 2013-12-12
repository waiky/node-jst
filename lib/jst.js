//     node-jsc 0.0.1-alpha.4
//     (c) Lorenzo Giuliani, 2011
//     license [MIT](http://opensource.org/licenses/mit-license.html)

var fs = require('fs')
  , path = require('path')
  , nodeWalk = require('walk')
  , spawn = require('child_process').spawn
  , _ = require('underscore')
  , compilers = {};

// **JST** will compile a directory full of [Handlebars](http://handlebarsjs.com),
// [Hogan.js](https://twitter.github.com/hogan.js) or
// [Underscore](https://documentcloud.github.com/underscore) templates into a
// single `templates.js` to use on the frontend 
//
// **NOTE** all files must have `.html` extension
//
// ## Configuration
//
//     var jst = require('jst');
//     jst.compiler = 'handlebars'; // or 'underscore' (default) or 'hogan'
//
// ## Example One-time Compile
// 
//     jst.compile(__dirname + '/templates', __dirname + '/public/javascripts/', function() {
//       return console.log('recompiled ' + '/javascripts/admin/templates.js'.red);
//     });
// 
// ## Example file Watcher
// 
//     jst.watcher(__dirname + '/templates', __dirname + '/public/javascripts/', function() {
//       return console.log('recompiled ' + '/javascripts/admin/templates.js'.red);
//     });
// 
//  this should not be used in a production environment
//
//     app.configure('production', function() {
//       jst.compile(__dirname + '/templates', __dirname + '/../public/javascripts/admin/', function() {
//         return console.log('recompiled ' + '/javascripts/admin/templates.js'.red);
//       });


// mustache-like underscore templates
_.templateSettings = {
  interpolate : /\{\{(.+?)\}\}/g
, evaluate: /\{\%(.+?)\%\}/g
};

// compilers template
compilers.std = {
  head: "(function(){this.{_ns} || (this.{_ns} = {});"
, foot: "}).call(this);"
};

// Handlebars templates.
compilers.handlebars = {
  compiler: function (file) {
    var handlebars = require('handlebars') || require('hbs').handlebars;
    return handlebars.precompile(fs.readFileSync(file, 'utf8')).toString();
  }
, partial: _.template(
    "Handlebars.registerPartial('{{ name }}', Handlebars.template({{ tpl }}));"
  )
, tpl: _.template(
      "this.{{ns}}['{{ name }}'] = function(context) { return HandlebarsTemplates['{{ name }}'](context); };"+
      "this._HandlebarsTemplates['{{ name }}'] = Handlebars.template({{ tpl }});"
  )
, head: compilers.std.head + "this._HandlebarsTemplates || (this._HandlebarsTemplates = {});"
, foot: compilers.std.foot
};

// Minstache minimalistic Mustache implementation
// Handlebars templates.
compilers.minstache = {
  compiler: function (file) {
    var minstache = require('minstache')
    return minstache.compile(fs.readFileSync(file, 'utf8')).toString();
  }
, tpl: _.template("this.{{ns}}['{{name}}'] = {{tpl}};\n")
, head: compilers.std.head
, foot: compilers.std.foot
};

// Underscore micro-templating
compilers.underscore = {
  settings: {
    evaluate:    /<%([\s\S]+?)%>/g
  , interpolate: /<%=([\s\S]+?)%>/g
  }
, compiler: function(file) {
    // stolen from Jammit
    return (
      new Function(
        'obj',
        'var __p=[],print=function(){__p.push.apply(__p,arguments);};with(obj||{}){__p.push(\'' +
        fs.readFileSync(file, 'utf8')
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\'")
          .replace(this.settings.interpolate, function (match, code) {
            return "'," + code.replace(/\\'/g, "'") + ",'";
          })
          .replace(this.settings.evaluate, function (match, code) {
            return "');" +
              code
                .replace(/\\'/g, "'")
                .replace(/[\r\n\t]/g, ' ') +
                "__p.push('";
          })
          .replace(/\r/g, '\\r')
          .replace(/\n/g, '\\n')
          .replace(/\t/g, '\\t') +
        "');}return __p.join('');"))
        .toString()
        .replace(' anonymous(obj)', '(obj)');
  }
, partial: function(ctx) { return this.tpl(ctx); }
, tpl: _.template("this.{{ns}}['{{ name }}']={{tpl}};")
, head: compilers.std.head
, foot: compilers.std.foot
};

// Hogan.js template engine
compilers.hogan = {
  compiler: function(file) {
    var Hogan = require('hogan.js'), c, text;
    text = fs.readFileSync(file, 'utf8')
      .replace(/\r/g, '')
      .replace(/\n/g, '')
      .replace(/\t/g, '');
    c = Hogan.compile(
        text
      , {asString: true});
    return {text: text, r: c};
  }
, partial: function(ctx) { return this.tpl(ctx); }
, tpl: _.template(
    "this._JST['{{name}}'] = new HoganTemplate();"
  + "this._JST['{{name}}'].r = {{tpl.r}};"
  + "this.{{ns}}['{{name}}'] = function(cx,p){return _JST['{{name}}'].r(cx,p)};\n"
  )
, head: compilers.std.head + 'this._JST||(this._JST={});'
, foot: compilers.std.foot
};

// Whiskers template engine
compilers.whiskers = {
  compiler: function(file) {
    var Whiskers = require('whiskers'), tpl, text;
    text = fs.readFileSync(file, 'utf8')
      .replace(/\r/g, '')
      .replace(/\n/g, '')
      .replace(/\t/g, '');

    tpl = Whiskers.compile(text).toString();
    return tpl;
  }
, partial: function(ctx) { return this.tpl(ctx); }
, tpl: _.template("this.{{ns}}['{{name}}'] = {{tpl}};\n")
, head: compilers.std.head +
    [ 'function g(obj, key, a, i) {'
    ,   'a = key.split(".");'
    ,   'for (i=0, l=a.length; i<l; i++) {'
    ,     'obj = obj[a[i]];'
    ,     'if (!obj) break;'
    ,   '}'
    ,   'if (!obj) obj = "";'
    ,   'return obj;'
    , '};'].join('')
, foot: compilers.std.foot
};

var jst = module.exports = {};

jst.compile = function (dir, output, callback) {
    var resolved_path = path.resolve(dir), resolved_output = path.resolve(output);
    var compiled = [], name = '', tpl = '', engine = jst.compilers[jst.compiler];
    compiled.push(engine.head.replace(/\{_ns\}/g, jst.namespace));

    walker = nodeWalk.walk(resolved_path)
    walker.on("file", function (root, fileStats, next) {
        var t = path.join(root, fileStats.name)
        tpl = engine.compiler(t);
        name = path.relative(resolved_path, t).replace(/\.html$/, '').split(path.sep).join('/')
        if (/^\_/.test(name)) {
            compiled.push(engine.partial({
                ns : jst.namespace,
                name : name.substring(1),
                tpl : tpl
            }));
        } else {
            compiled.push(engine.tpl({
                ns : jst.namespace,
                name : name,
                tpl : tpl
            }));
        }
        next();
    });
    walker.on("end", function () {
        compiled.push(engine.foot);
        fs.writeFile(resolved_output + "/templates.js", compiled.join(''), function (err) {
            if (err)
                throw err;
            if (typeof callback === "function")
                return callback(err);
        });
    });
};

jst.watcher = function(dir, output, callback) {
  walk(dir, function (e, files) {
    if (e) throw e;
    _.each(files, function (f) {
      fs.watch(f, function(event, filename) {
        jst.compile(dir, output, callback);
      })
    });
  });
};

jst.compilers = compilers;

// Defaults
jst.compiler = 'underscore';
jst.namespace = 'JST';

//according to my [small test](https://gist.github.com/1521429) ... spanw('find'...) wins
function walk (dir, cb, filter, type) {
  filter = filter || '*.html';
  type = type || 'f';
  dir = path.resolve(process.cwd(), dir);
  var find = spawn('find', [dir, '-name', filter, '-type', type, '-print'])
    , output = [];

  find.stdout.on('data', function (data) {
    if (/^execvp\(\)/.test(data)) {
      return cb(new Error('Failed to start child process.'));
    } else {
      data.toString().split(/\n/).forEach(function (str) {
        if (str.length > 1) output.push(str);
      });
    }
  });
  find.stdout.on('end', function () {
    cb(null, output);
  });
  find.on('exit', function (code) {
    if (code > 0) {
      return cb(new Error('Process failed with code: ' + code));
    }
  });
}
// this function can be useful outside
module.exports._walk = walk;