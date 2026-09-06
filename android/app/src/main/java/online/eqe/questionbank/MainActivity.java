package online.eqe.questionbank;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;

/**
 * The whole app is a single offline HTML/CSS/JS page (question-bank.html,
 * built by tools/build-question-bank.js from the scraped exam data). This
 * activity is a thin WebView shell around it — no network, no server, no
 * separate native UI to keep in sync with the web app.
 */
public class MainActivity extends AppCompatActivity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        // localStorage is how the app persists progress, settings and the
        // daily study log — required for the whole app to be useful.
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    // "Voir sur e-qe.online" style links: hand off to the
                    // user's browser instead of navigating the offline shell.
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    return true;
                }
                return false; // file:// asset navigation stays in the WebView
            }
        });

        webView.loadUrl("file:///android_asset/question-bank.html");

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    // A real page navigation happened (e.g. the "Ressources
                    // externes" link to data.html) — unwind that first.
                    webView.goBack();
                    return;
                }
                webView.evaluateJavascript(
                        "(function(){try{return !!(window.__qbAndroidBack && window.__qbAndroidBack());}catch(e){return false;}})();",
                        handled -> {
                            if (!"true".equals(handled)) {
                                moveTaskToBack(true);
                            }
                        });
            }
        });
    }
}
